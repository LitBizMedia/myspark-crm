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
  const startDate = new Date(now.getTime() + 12 * 3600000).toISOString().slice(0, 10);
  const endDate   = new Date(now.getTime() + 36 * 3600000).toISOString().slice(0, 10);

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

  for (const appt of appointments) {
    const data = await getCachedSubData(appt.subaccount_id);
    if (!data) { skipped++; continue; }

    // Compute the actual appointment timestamp in the subaccount's TZ.
    // This is the appointment's wall-clock time, converted to absolute UTC.
    const subTz = (data.settings && data.settings.timezone) || 'America/Chicago';
    const apptDate = apptTimestampInTz(appt.date, appt.time || '00:00', subTz);
    if (!apptDate) { skipped++; continue; }

    const hoursUntilDate = (apptDate - now) / 3600000;

    // Window: 22-26 hours away from now (centered on 24h reminder).
    // Cron runs hourly so this catches every appointment exactly once.
    if (hoursUntilDate < 22 || hoursUntilDate > 26) {
      skipped++;
      continue;
    }

    const alreadySent = await reminderAlreadySent(appt.subaccount_id, appt.id);
    if (alreadySent) { skipped++; continue; }

    const contact = appt.contact_id
      ? (data.contacts || []).find(c => c.id === appt.contact_id)
      : null;
    if (!contact) { skipped++; continue; }

    const bizName = (data.settings && data.settings.businessName) || 'MySpark+';
    const staff = appt.assigned_to
      ? (data.users || []).find(u => u.id === appt.assigned_to)
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

    if (contact.email) {
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

    if (contact.phone) {
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
    try {
      return await runReminders();
    } catch (e) {
      console.error('reminders eventbridge error:', e);
      return { success: false, error: e.message };
    }
  }

  return httpWrapped(event, context);
};
