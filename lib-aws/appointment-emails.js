// Appointment confirmation email sender.
// Used by appointments-upsert AFTER successful save to send confirmation
// emails to clients. Reuses lib/resend.js for transport and template logic.
//
// Solo bookings: send to the appointment's contact_id if they have an email.
// Group bookings: send to every client in appointment_clients that has an email.
//
// Each email is personalized with the client's name. No cancel/reschedule links
// per current policy ("by call only").

const { sendEmail } = require('./resend');

function fmtDate(d) {
  if (!d) return '';
  try {
    const [y, m, day] = d.split('-').map(Number);
    const dt = new Date(y, m - 1, day);
    return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } catch (e) { return d; }
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

function buildHtml({ clientName, serviceName, dateStr, timeStr, staffName, location, businessName }) {
  const locRow = location
    ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Location</td><td style="padding:8px 0;font-weight:600">' + escHtml(location) + '</td></tr>'
    : '';
  const staffRow = staffName
    ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">With</td><td style="padding:8px 0;font-weight:600">' + escHtml(staffName) + '</td></tr>'
    : '';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">Appointment Confirmed</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + escHtml(clientName) + ', your appointment has been confirmed.</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Service</td><td style="padding:8px 0;font-weight:600">' + escHtml(serviceName) + '</td></tr>'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Date</td><td style="padding:8px 0;font-weight:600">' + escHtml(dateStr) + '</td></tr>'
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
//   subaccountSlug: 'litbiz', // used to build resend slug
//   appointmentTitle, appointmentDate, appointmentTime, location,
//   recipients: [{contact_id, name, email, is_primary}],
//   staffName, businessName
// }
// Skips silently on errors so a Resend hiccup never breaks the booking flow.
async function sendAppointmentConfirmations(opts) {
  const {
    subaccountSlug, appointmentTitle, appointmentDate, appointmentTime,
    location, recipients, staffName, businessName
  } = opts;

  if (!Array.isArray(recipients) || !recipients.length) return { sent: 0 };
  if (!subaccountSlug) return { sent: 0, error: 'no slug' };

  const dateStr = fmtDate(appointmentDate);
  const timeStr = fmtTime(appointmentTime);
  let sent = 0;

  for (const r of recipients) {
    if (!r.email) continue;
    const html = buildHtml({
      clientName: r.name || 'there',
      serviceName: appointmentTitle,
      dateStr, timeStr, staffName, location,
      businessName: businessName || 'MySpark+'
    });
    try {
      const result = await sendEmail(subaccountSlug, {
        to: r.email,
        subject: 'Appointment Confirmed: ' + appointmentTitle + ' on ' + dateStr,
        html,
        fromName: businessName || 'MySpark+',
        templateType: 'appt-confirmation',
        contactId: r.contact_id,
        vars: {
          contact_name: r.name || '',
          contact_email: r.email || '',
          appointment_date: dateStr,
          appointment_time: timeStr,
          appointment_service: appointmentTitle,
          staff_name: staffName || '',
          business_name: businessName || 'MySpark+'
        }
      });
      if (result && result.ok) sent++;
    } catch (e) {
      console.warn('appt confirmation send failed for', r.email, ':', e.message);
    }
  }

  return { sent };
}

module.exports = { sendAppointmentConfirmations };
