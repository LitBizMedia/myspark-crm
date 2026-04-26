// api/cron/reminders.js
// Runs hourly via Vercel cron.
// Sends 24-hour appointment reminders via email and SMS.

const { sendEmail } = require('../../lib/resend');
const { sendSms } = require('../../lib/twilio');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
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
  const url = SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.'
    + encodeURIComponent(subaccountId) + '&select=data&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows.length ? rows[0].data : null;
  } catch (e) {
    console.error('getSubaccountData error:', e.message);
    return null;
  }
}

async function getSmsSettings(subaccountId) {
  const url = SUPABASE_URL + '/rest/v1/sms_settings?subaccount_id=eq.'
    + encodeURIComponent(subaccountId) + '&select=*&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

async function getTemplate(subaccountId, templateType) {
  const url = SUPABASE_URL + '/rest/v1/email_templates?subaccount_id=eq.'
    + encodeURIComponent(subaccountId)
    + '&template_type=eq.' + encodeURIComponent(templateType)
    + '&enabled=eq.true&select=subject,body_html&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows.length ? rows[0] : null;
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
    await fetch(SUPABASE_URL + '/rest/v1/appointment_reminders', {
      method: 'POST',
      headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        subaccount_id: subaccountId,
        appointment_id: appointmentId,
        reminder_type: 'pre-24h',
        email_sent: emailSent,
        sms_sent: smsSent,
        sent_at: new Date().toISOString()
      })
    });
  } catch (e) {
    console.error('logReminder error:', e.message);
  }
}

async function reminderAlreadySent(subaccountId, appointmentId) {
  const url = SUPABASE_URL + '/rest/v1/appointment_reminders?subaccount_id=eq.'
    + encodeURIComponent(subaccountId)
    + '&appointment_id=eq.' + encodeURIComponent(appointmentId)
    + '&reminder_type=eq.pre-24h&select=id&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return false;
    const rows = await res.json();
    return rows && rows.length > 0;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== 'Bearer ' + CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() + 22 * 3600000);
  const windowEnd = new Date(now.getTime() + 26 * 3600000);
  const startDate = windowStart.toISOString().split('T')[0];
  const endDate = windowEnd.toISOString().split('T')[0];

  console.log('Checking appointments between ' + startDate + ' and ' + endDate);

  const apptRes = await fetch(
    SUPABASE_URL + '/rest/v1/appointments?status=eq.scheduled&date=gte.' + startDate + '&date=lte.' + endDate + '&select=*',
    { headers: svcHeaders() }
  );

  if (!apptRes.ok) {
    return res.status(500).json({ error: 'Failed to fetch appointments' });
  }

  const appointments = await apptRes.json();
  console.log('Found ' + appointments.length + ' upcoming appointments.');

  let emailsSent = 0;
  let smsSent = 0;
  let skipped = 0;

  for (const appt of appointments) {
    // Use date only for window check to avoid timezone issues
    // The cron runs hourly so appointments on the right date within a generous window are included
    const apptDate = new Date(appt.date + 'T12:00:00Z');
    const hoursUntilDate = (apptDate - now) / 3600000;
    console.log('Appt:', appt.id, 'date:', appt.date, 'hoursUntilDate:', hoursUntilDate.toFixed(2));
    if (hoursUntilDate < 12 || hoursUntilDate > 36) {
      console.log('SKIP date window:', hoursUntilDate.toFixed(2));
      skipped++;
      continue;
    }

    const alreadySent = await reminderAlreadySent(appt.subaccount_id, appt.id);
    if (alreadySent) { console.log('SKIP already sent:', appt.id); skipped++; continue; }

    const data = await getSubaccountData(appt.subaccount_id);
    if (!data) { console.log('SKIP no data:', appt.subaccount_id); skipped++; continue; }

    const contact = appt.contact_id
      ? (data.contacts || []).find(c => c.id === appt.contact_id)
      : null;
    if (!contact) { console.log('SKIP no contact:', appt.contact_id, 'for appt:', appt.id); skipped++; continue; }

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

    // Email reminder
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

    // SMS reminder
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

  return res.status(200).json({ success: true, emailsSent, smsSent, skipped });
};
