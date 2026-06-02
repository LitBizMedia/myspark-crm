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
const { sendEmail } = require('./lib/mailgun');
const { sendSms } = require('./lib/twilio');
const { wrap } = require('./lib/lambda-adapter');
const { apptTimestampInTz } = require('./lib/timezone');
const { canSubaccountSendSms } = require('./lib/sms-gate');
const { shouldSend } = require('./lib/notifications');
const reminderEmail = require('./lib/reminder-email');

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

function fmtDate(dateInput) {
  if (!dateInput) return '';
  // dateInput may be a Date object (from pg date columns) or a YYYY-MM-DD string.
  // Normalize to YYYY-MM-DD then anchor at noon to avoid timezone day-shift.
  let yyyymmdd;
  if (dateInput instanceof Date) {
    yyyymmdd = dateInput.toISOString().slice(0, 10);
  } else {
    yyyymmdd = String(dateInput).slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return String(dateInput);
  const d = new Date(yyyymmdd + 'T12:00:00');
  if (isNaN(d.getTime())) return String(dateInput);
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

// getSmsSettings removed 2026-05-21: replaced by lib/sms-gate.canSubaccountSendSms helper.

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
    }, { onConflict: ['subaccount_id', 'appointment_id', 'reminder_type'] });
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
  let emailsFailed = 0;
  let smsFailed = 0;
  let skipped = 0;

  // Cache subaccount data per-tenant since multiple appts share a subaccount
  const subDataCache = new Map();
  async function getCachedSubData(subaccountId) {
    if (subDataCache.has(subaccountId)) return subDataCache.get(subaccountId);
    const d = await getSubaccountData(subaccountId);
    subDataCache.set(subaccountId, d);
    return d;
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

    // Subaccount-level notification settings are the only gate.
    // If the admin has disabled appointment_reminder for this subaccount,
    // skip the appointment entirely.
    const notifGate = await shouldSend(appt.subaccount_id, 'appointment_reminder', db);
    if (!notifGate.ok) { skipped++; continue; }

    // Timing and channels come from the global notification settings.
    let hoursBefore = notifGate.timing_minutes_before
      ? Math.round(notifGate.timing_minutes_before / 60)
      : 24;
    let emailEnabled = notifGate.email_enabled;
    let smsEnabled = notifGate.sms_enabled;

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
      appointment_title: appt.title || 'Appointment',
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
          // Fallback to default template from reminder-email lib
          subject = reminderEmail.buildSubject(vars);
          html = reminderEmail.buildHtml(vars);
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
        if (result.ok) {
          emailSentFlag = true;
          emailsSent++;
        } else {
          emailsFailed++;
          console.error('Email reminder send failed:', (result && result.error) || 'unknown');
        }
      } catch (e) {
        emailsFailed++;
        console.error('Email reminder error:', e.message);
      }
    }

    if (smsEnabled && contact.phone) {
      // TODO (future-ready): also check contact-level sms_opt_out flag once
      // the contacts schema gains that field. Twilio handles STOP at the
      // carrier level today, but a contact-side flag prevents wasted send
      // attempts and gives staff visibility into who has opted out.
      const gate = await canSubaccountSendSms(appt.subaccount_id, db);
      if (gate.ok) {
        try {
          const smsBody = 'Reminder: your ' + appt.title + ' is tomorrow'
            + (timeStr ? ' at ' + timeStr : '') + '. Reply STOP to opt out.';
          const result = await sendSms(slug, {
            to: contact.phone,
            body: smsBody,
            templateType: 'appt-reminder',
            contactId: contact.id,
            purpose: 'transactional'
          });
          if (result.ok) {
            smsSentFlag = true;
            smsSent++;
          } else {
            smsFailed++;
            console.error('SMS reminder send failed:', (result && result.error) || 'unknown');
          }
        } catch (e) {
          smsFailed++;
          console.error('SMS reminder error:', e.message);
        }
      } else {
        // Gate denied is expected when a tenant is not A2P-live. Logged for visibility.
        console.log('SMS gate denied for ' + appt.subaccount_id + ': ' + gate.reason + (gate.status ? ' (status=' + gate.status + ')' : ''));
      }
    }

    await logReminder(appt.subaccount_id, appt.id, emailSentFlag, smsSentFlag);
  }

  return { success: true, emailsSent, smsSent, emailsFailed, smsFailed, failed: emailsFailed + smsFailed, skipped };
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
