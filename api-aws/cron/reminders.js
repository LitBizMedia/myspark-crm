// api/cron/reminders.js (Lambda version - Secrets Manager)
//
// Hourly cron - sends 24-hour appointment reminders via email and SMS.
//
// AWS schedule: EventBridge → cron(0 * * * ? *)
//
// CREDENTIALS: CRON_SECRET (HTTP testing path) from Secrets Manager.
//
// CHANGED 2026-05-07: TZ-aware. The 24-hour-out window is computed against
// each appointment's actual wall-clock time in the subaccount's timezone.
// Previously the cron compared against UTC noon as a proxy for appt time,
// which made reminders fire at the wrong hour for any non-UTC business.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { sendEmail } = require('./lib/resend');
const { sendSms } = require('./lib/twilio');
const { wrap } = require('./lib/lambda-adapter');
const { apptTimestampInTz } = require('./lib/timezone');

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function getSubaccountData(subaccountId) {
  try {
    const r = await db.findOne('subaccount_data',
      { subaccount_id: subaccountId },
      { select: 'data' }
    );
    return r ? r.data : null;
  } catch (e) {
    console.error('getSubaccountData error:', e.message);
    return null;
  }
}

// Load widget reminder config for a subaccount. Returns map of widget_id -> config.
async function getWidgetReminderConfig(subaccountId) {
  try {
    const r = await db.query(
      `SELECT id, send_reminder_email, send_reminder_sms, reminder_hours_before
         FROM service_widgets
        WHERE subaccount_id = $1`,
      [subaccountId]
    );
    const map = {};
    for (const w of r.rows) {
      map[w.id] = {
        send_reminder_email: w.send_reminder_email !== false,
        send_reminder_sms: !!w.send_reminder_sms,
        reminder_hours_before: w.reminder_hours_before != null ? parseInt(w.reminder_hours_before) : 24
      };
    }
    return map;
  } catch (e) {
    console.error('getWidgetReminderConfig error:', e.message);
    return {};
  }
}

async function getSmsSettings(subaccountId) {
  try {
    return await db.findOne('sms_settings', { subaccount_id: subaccountId });
  } catch (e) {
    return null;
  }
}

async function getTemplate(subaccountId, templateType) {
  try {
    return await db.findOne('email_templates',
      { subaccount_id: subaccountId, template_type: templateType, enabled: true },
      { select: 'subject, body_html' }
    );
  } catch (e) {
    return null;
  }
}

function applyVars(str, vars) {
  if (!str || !vars) return str;
  return Object.keys(vars).reduce((result, key) => {
    return result.split('{{' + key + '}}').join(vars[key] != null ? String(vars[key]) : '');
  }, str);
}

async function logReminder(subaccountId, appointmentId, emailSent, smsSent) {
  try {
    await db.insertOne('appointment_reminders', {
      subaccount_id: subaccountId,
      appointment_id: appointmentId,
      reminder_type: 'pre-24h',
      email_sent: emailSent,
      sms_sent: smsSent,
      sent_at: new Date().toISOString()
    }, { onConflict: 'subaccount_id,appointment_id,reminder_type' });
  } catch (e) {
    console.error('logReminder error:', e.message);
  }
}

async function reminderAlreadySent(subaccountId, appointmentId) {
  try {
    const r = await db.findOne('appointment_reminders',
      { subaccount_id: subaccountId, appointment_id: appointmentId, reminder_type: 'pre-24h' },
      { select: 'id' }
    );
    return !!r;
  } catch (e) {
    return false;
  }
}

async function runReminders() {
  const now = new Date();

  // Cast a wide UTC date net first to limit DB scan, then filter precisely
  // against each appointment's actual TZ-aware timestamp.
  // Window goes out to 72h to accommodate widgets configured up to 48h-before
  // reminders. Per-widget hours_before is then enforced precisely below.
  const startDate = new Date(now.getTime() + 0 * 3600000).toISOString().slice(0, 10);
  const endDate   = new Date(now.getTime() + 72 * 3600000).toISOString().slice(0, 10);

  const apptsResult = await db.query(
    `SELECT * FROM appointments
     WHERE status = 'scheduled' AND date >= $1 AND date <= $2`,
    [startDate, endDate]
  );
  const appointments = apptsResult.rows;

  let emailsSent = 0;
  let smsSent = 0;
  let skipped = 0;

  // Cache subaccount data per-tenant since multiple appts share a subaccount
  const subDataCache = new Map();
  async function getCachedSubData(subaccountId) {
    if (subDataCache.has(subaccountId)) return subDataCache.get(subaccountId);
    const d = await getSubaccountData(subaccountId);
    subDataCache.set(subaccountId, d);
    return d;
  }
  // Cache widget reminder configs per-tenant
  const widgetCfgCache = new Map();
  async function getCachedWidgetCfgs(subaccountId) {
    if (widgetCfgCache.has(subaccountId)) return widgetCfgCache.get(subaccountId);
    const cfgs = await getWidgetReminderConfig(subaccountId);
    widgetCfgCache.set(subaccountId, cfgs);
    return cfgs;
  }

  // Pre-fetch contacts and users referenced by this batch in one query each.
  // Contacts and users moved to RDS; do not read them from the blob.
  const contactIds = [...new Set(appointments.map(a => a.contact_id).filter(Boolean))];
  const staffIds   = [...new Set(appointments.map(a => a.assigned_to).filter(Boolean))];

  const contactMap = new Map();
  if (contactIds.length) {
    const cRes = await db.query(
      `SELECT id, display_name, first_name, last_name, email, phone
         FROM contacts
        WHERE id = ANY($1::text[])`,
      [contactIds]
    );
    for (const row of cRes.rows) {
      const name = row.display_name
        || [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
        || '';
      contactMap.set(row.id, { id: row.id, name, email: row.email, phone: row.phone });
    }
  }

  const userMap = new Map();
  if (staffIds.length) {
    const uRes = await db.query(
      `SELECT id::text AS id, display_name, username
         FROM subaccount_users
        WHERE id::text = ANY($1::text[])`,
      [staffIds]
    );
    for (const row of uRes.rows) {
      userMap.set(row.id, { id: row.id, name: row.display_name || '', username: row.username || '' });
    }
  }

  for (const appt of appointments) {
    const data = await getCachedSubData(appt.subaccount_id);
    if (!data) { skipped++; continue; }

    // Compute the actual appointment timestamp in the subaccount's TZ.
    const subTz = (data.settings && data.settings.timezone) || 'America/Chicago';
    const apptDate = apptTimestampInTz(appt.date, appt.time || '00:00', subTz);
    if (!apptDate) { skipped++; continue; }

    const hoursUntilDate = (apptDate - now) / 3600000;

    // Determine reminder config: per-widget for widget-booked appts, defaults otherwise.
    // Non-widget defaults preserve existing behavior (24h, both channels attempted).
    let hoursBefore = 24;
    let emailEnabled = true;
    let smsEnabled = true;
    if (appt.booked_via === 'widget' && appt.widget_id) {
      const widgetCfgs = await getCachedWidgetCfgs(appt.subaccount_id);
      const cfg = widgetCfgs[appt.widget_id];
      if (cfg) {
        hoursBefore = cfg.reminder_hours_before;
        emailEnabled = cfg.send_reminder_email;
        smsEnabled = cfg.send_reminder_sms;
      }
    }

    // Window: hoursBefore +/- 2 hours. Cron runs hourly so each appt is
    // checked multiple times in this 4h window; idempotency guard below
    // prevents duplicate sends.
    if (hoursUntilDate < hoursBefore - 2 || hoursUntilDate > hoursBefore + 2) {
      skipped++;
      continue;
    }

    // Skip entirely if both channels are disabled
    if (!emailEnabled && !smsEnabled) {
      skipped++;
      continue;
    }

    const alreadySent = await reminderAlreadySent(appt.subaccount_id, appt.id);
    if (alreadySent) { skipped++; continue; }

    const contact = appt.contact_id
      ? (contactMap.get(appt.contact_id) || null)
      : null;
    if (!contact) { skipped++; continue; }

    const bizName = (data.settings && data.settings.businessName) || 'MySpark+';
    const staff = appt.assigned_to
      ? (userMap.get(appt.assigned_to) || null)
      : null;
    const staffName = staff ? (staff.name || staff.username) : '';
    const dateStr = fmtDate(appt.date);
    const timeStr = appt.time ? fmtTime(appt.time) : '';
    const slug = appt.subaccount_id.replace('sub-', '');

    const vars = {
      contact_name: contact.name || '',
      contact_email: contact.email || '',
      contact_phone: contact.phone || '',
      appointment_date: dateStr,
      appointment_time: timeStr,
      appointment_service: appt.title,
      staff_name: staffName,
      business_name: bizName
    };

    let emailSentFlag = false;
    let smsSentFlag = false;

    if (emailEnabled && contact.email) {
      try {
        const tpl = await getTemplate(appt.subaccount_id, 'appt-reminder');
        let subject, html;
        if (tpl) {
          subject = applyVars(tpl.subject, vars);
          html = applyVars(tpl.body_html, vars);
        } else {
          subject = 'Reminder: ' + appt.title + ' tomorrow' + (timeStr ? ' at ' + timeStr : '');
          html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
            + '<h2 style="color:#6b21ea;margin:0 0 8px">Appointment Reminder</h2>'
            + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + contact.name + ', this is a reminder about your appointment tomorrow.</p>'
            + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
            + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Service</td><td style="padding:8px 0;font-weight:600">' + appt.title + '</td></tr>'
            + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Date</td><td style="padding:8px 0;font-weight:600">' + dateStr + '</td></tr>'
            + (timeStr ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Time</td><td style="padding:8px 0;font-weight:600">' + timeStr + '</td></tr>' : '')
            + (staffName ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">With</td><td style="padding:8px 0;font-weight:600">' + staffName + '</td></tr>' : '')
            + '</table>'
            + '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">Need to reschedule? Reply to this email or give us a call.</p>'
            + '<p style="color:#5a4d7a;font-size:14px;margin:0">' + bizName + '</p>'
            + '</div>';
        }
        const result = await sendEmail(slug, {
          scope: 'subaccount',
          source: 'reminder',
          to: contact.email,
          subject: subject,
          html: html,
          fromName: bizName,
          templateType: 'appt-reminder',
          contactId: contact.id
        });
        if (result.ok) { emailSentFlag = true; emailsSent++; }
      } catch (e) {
        console.error('Email reminder error:', e.message);
      }
    }

    if (smsEnabled && contact.phone) {
      try {
        const smsSettings = await getSmsSettings(appt.subaccount_id);
        if (smsSettings && smsSettings.enabled && smsSettings.campaign_status === 'approved') {
          const smsBody = 'Reminder: your ' + appt.title + ' is tomorrow'
            + (timeStr ? ' at ' + timeStr : '') + '. Reply STOP to opt out.';
          const result = await sendSms(slug, {
            to: contact.phone,
            body: smsBody,
            templateType: 'appt-reminder',
            contactId: contact.id
          });
          if (result.ok) { smsSentFlag = true; smsSent++; }
        }
      } catch (e) {
        console.error('SMS reminder error:', e.message);
      }
    }

    await logReminder(appt.subaccount_id, appt.id, emailSentFlag, smsSentFlag);
  }

  return { success: true, emailsSent, smsSent, skipped };
}

async function httpHandler(req, res) {
  const auth = req.headers.authorization || '';
  const cronSecret = await getCronSecret();
  if (cronSecret && auth !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runReminders();
    return res.status(200).json(result);
  } catch (e) {
    console.error('reminders error:', e);
    return res.status(500).json({ error: e.message });
  }
}

const httpWrapped = wrap(httpHandler);

exports.handler = async function (event, context) {
  const isScheduledEvent = event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler');

  if (isScheduledEvent) {
    // Scheduled mode: re-throw on errors so Lambda Errors metric fires.
    // summary.failed (failed reminder sends) is treated as a real failure
    // since reminders are time-sensitive and should retry-via-alarm.
    let summary;
    try {
      summary = await runReminders();
    } catch (e) {
      console.error('reminders eventbridge fatal error:', e.stack || e.message);
      throw e;
    }
    if (summary && summary.failed > 0) {
      console.error('reminders had ' + summary.failed + ' failures. Summary:', JSON.stringify(summary, null, 2));
      const err = new Error('reminders had ' + summary.failed + ' failed sends');
      err.summary = summary;
      throw err;
    }
    return summary;
  }

  return httpWrapped(event, context);
};
