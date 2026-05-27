// lib-aws/reminder-email.js
//
// HTML + subject builder for appointment reminder emails.
// Owns the default reminder template. When a subaccount has a custom
// template in email_templates (template_type='appt-reminder'), the cron
// uses that instead; this lib is only the fallback default and the
// preview source.

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Variables used by the reminder template:
 *   contact_name        - patient display name
 *   appointment_title   - service title shown in subject and body
 *   appointment_date    - formatted date string ("Tuesday, June 2")
 *   appointment_time    - formatted time string (may be empty for all-day appts)
 *   staff_name          - assigned staff display name (may be empty)
 *   business_name       - clinic name
 */

function buildSubject(vars) {
  const title = vars.appointment_title || 'Appointment';
  const time = vars.appointment_time || '';
  return 'Reminder: ' + title + ' tomorrow' + (time ? ' at ' + time : '');
}

function buildHtml(vars) {
  const contactName = escHtml(vars.contact_name || 'there');
  const title = escHtml(vars.appointment_title || 'Appointment');
  const dateStr = escHtml(vars.appointment_date || '');
  const timeStr = escHtml(vars.appointment_time || '');
  const staffName = escHtml(vars.staff_name || '');
  const bizName = escHtml(vars.business_name || 'MySpark+');

  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">Appointment Reminder</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + contactName + ', this is a reminder about your appointment tomorrow.</p>'
    + '<div style="text-align:center;font-size:20px;font-weight:700;color:#1a1030;margin:0 0 20px;padding:16px;background:#f7f5fc;border-radius:8px">' + title + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Date</td><td style="padding:8px 0;font-weight:600">' + dateStr + '</td></tr>'
    + (timeStr ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Time</td><td style="padding:8px 0;font-weight:600">' + timeStr + '</td></tr>' : '')
    + (staffName ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">With</td><td style="padding:8px 0;font-weight:600">' + staffName + '</td></tr>' : '')
    + '</table>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">Need to reschedule? Reply to this email or give us a call.</p>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0">' + bizName + '</p>'
    + '</div>';
}

module.exports = { buildSubject, buildHtml };
