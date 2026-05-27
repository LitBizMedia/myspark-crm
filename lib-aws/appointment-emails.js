// Appointment confirmation email sender.
// Used by appointments-upsert AFTER successful save to send confirmation
// emails to clients. Uses lib/mailgun.js for transport and template logic.
//
// Solo bookings: send to the appointment's contact_id if they have an email.
// Group bookings: send to every client in appointment_clients that has an email.
//
// Each email is personalized with the client's name. No cancel/reschedule links
// per current policy ("by call only").

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');

function fmtDate(d) {
  if (!d) return '';
  try {
    // d may be a Date object (from pg date columns) or a YYYY-MM-DD string.
    const s = (typeof d === 'string') ? d.slice(0, 10) : (d instanceof Date ? d.toISOString().slice(0, 10) : null);
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, day] = s.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, day, 12));
      return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Indiana/Indianapolis' });
    }
    // Fallback: try parsing whatever was passed
    const dt = new Date(d);
    if (!isNaN(dt.getTime())) {
      return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    return String(d);
  } catch (e) { return String(d); }
}

function fmtTime(t) {
  if (!t) return '';
  try {
    const [hh, mm] = t.split(':').map(Number);
    const period = hh >= 12 ? 'PM' : 'AM';
    const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
    return h12 + ':' + String(mm).padStart(2, '0') + ' ' + period;
  } catch (e) { return t; }
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml({ clientName, serviceName, dateStr, timeStr, staffName, location, businessName, rescheduleFromDateStr, rescheduleFromTimeStr }) {
  const locRow = location
    ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Location</td><td style="padding:8px 0;font-weight:600">' + escHtml(location) + '</td></tr>'
    : '';
  const staffRow = staffName
    ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">With</td><td style="padding:8px 0;font-weight:600">' + escHtml(staffName) + '</td></tr>'
    : '';
  const isReschedule = !!(rescheduleFromDateStr);
  const heading = isReschedule ? 'Appointment Rescheduled' : 'Appointment Confirmed';
  const intro = isReschedule
    ? 'Hi ' + escHtml(clientName) + ', your appointment has been moved to a new date and time.'
    : 'Hi ' + escHtml(clientName) + ', your appointment has been confirmed.';
  const fromRow = isReschedule
    ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Was</td><td style="padding:8px 0;color:#5a4d7a;text-decoration:line-through">' + escHtml(rescheduleFromDateStr) + (rescheduleFromTimeStr ? ' at ' + escHtml(rescheduleFromTimeStr) : '') + '</td></tr>'
    : '';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">' + heading + '</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">' + intro + '</p>'
    + '<div style="text-align:center;font-size:20px;font-weight:700;color:#1a1030;margin:0 0 20px;padding:16px;background:#f7f5fc;border-radius:8px">' + escHtml(serviceName || 'Appointment') + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + fromRow
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">' + (isReschedule ? 'Now' : 'Date') + '</td><td style="padding:8px 0;font-weight:600">' + escHtml(dateStr) + '</td></tr>'
    + (timeStr ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Time</td><td style="padding:8px 0;font-weight:600">' + escHtml(timeStr) + '</td></tr>' : '')
    + staffRow + locRow
    + '</table>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">Need to reschedule? Please give us a call.</p>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0">' + escHtml(businessName) + '</p>'
    + '</div>';
}

// Sends confirmation emails for a saved appointment.
// opts: {
//   subaccountId: 'sub-id',
//   subaccountSlug: 'litbiz',  // used to build subaccount slug
//   appointmentTitle, appointmentDate, appointmentTime, location,
//   recipients: [{contact_id, name, email, is_primary}],
//   staffName, businessName
// }
// Skips silently on errors so a Mailgun hiccup never breaks the booking flow.
async function sendAppointmentConfirmations(opts) {
  const {
    subaccountId,
    subaccountSlug, appointmentTitle, appointmentDate, appointmentTime,
    location, recipients, staffName, businessName,
    // Optional overrides used by reschedule flow (and any future variant).
    // If subjectOverride is set, it replaces the default 'Appointment Confirmed: ...'.
    // If oldDate/oldTime are set, the email body and vars include the previous slot.
    // templateTypeOverride changes the email_log templateType for tracking.
    subjectOverride, oldDate, oldTime, templateTypeOverride
  } = opts;

  if (!Array.isArray(recipients) || !recipients.length) return { sent: 0 };
  if (!subaccountSlug) return { sent: 0, error: 'no slug' };

  const isReschedule = !!(oldDate && oldTime);

  // Gate via subaccount Notifications tab. If subaccountId not passed
  // (older callers), skip the gate and send (backward compatible).
  if (subaccountId) {
    const typeKey = isReschedule ? 'appointment_reschedule' : 'appointment_confirmation';
    const gate = await shouldSend(subaccountId, typeKey, db);
    if (!gate.ok) return { sent: 0, skipped: true, reason: gate.reason || 'disabled' };
  }

  const dateStr = fmtDate(appointmentDate);
  const timeStr = fmtTime(appointmentTime);
  const oldDateStr = oldDate ? fmtDate(oldDate) : '';
  const oldTimeStr = oldTime ? fmtTime(oldTime) : '';
  let sent = 0;

  for (const r of recipients) {
    if (!r.email) continue;
    const html = buildHtml({
      clientName: r.name || 'there',
      serviceName: appointmentTitle,
      dateStr, timeStr, staffName, location,
      businessName: businessName || 'MySpark+',
      rescheduleFromDateStr: isReschedule ? oldDateStr : '',
      rescheduleFromTimeStr: isReschedule ? oldTimeStr : ''
    });
    try {
      const result = await sendEmail(subaccountSlug, {
        scope: 'subaccount',
        source: isReschedule ? 'reschedule' : 'confirmation',
        to: r.email,
        subject: subjectOverride || ('Appointment Confirmed: ' + appointmentTitle + ' on ' + dateStr),
        html,
        fromName: businessName || 'MySpark+',
        templateType: templateTypeOverride || 'appt-confirmation',
        contactId: r.contact_id,
        vars: {
          contact_name: r.name || '',
          contact_email: r.email || '',
          appointment_date: dateStr,
          appointment_time: timeStr,
          appointment_service: appointmentTitle,
          staff_name: staffName || '',
          business_name: businessName || 'MySpark+',
          rescheduled_from_date: oldDateStr,
          rescheduled_from_time: oldTimeStr
        }
      });
      if (result && result.ok) sent++;
    } catch (e) {
      console.warn('appt confirmation send failed for', r.email, ':', e.message);
    }
  }

  return { sent };
}

module.exports = { sendAppointmentConfirmations, buildHtml };
