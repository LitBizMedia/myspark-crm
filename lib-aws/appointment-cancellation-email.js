// lib-aws/appointment-cancellation-email.js
//
// Sends a cancellation confirmation to the patient when their appointment
// is cancelled. Two trigger points:
//   - api/subaccount/appointments-delete (staff cancels via calendar)
//   - api/booking/booking-cancel (patient self-cancels via email link)
//
// Gates via shouldSend('appointment_cancellation'). Non-fatal: email
// failure doesn't roll back the cancellation.

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');
const { sendPatientSms } = require('./patient-sms');

function fmtDate(d) {
  if (!d) return '';
  try {
    const s = (typeof d === 'string') ? d.slice(0, 10) : null;
    if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const [y, m, day] = s.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
    }
    return new Date(d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  } catch (e) { return String(d); }
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  const hh = parseInt(h, 10);
  if (isNaN(hh)) return String(t);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh === 0 ? 12 : (hh > 12 ? hh - 12 : hh);
  return h12 + ':' + (m || '00') + ' ' + ampm;
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSubject(opts) {
  const title = opts.appointmentTitle || 'Your appointment';
  const dateStr = opts.dateStr || fmtDate(opts.appointmentDate);
  return 'Cancelled: ' + title + (dateStr ? ' on ' + dateStr : '');
}

function buildHtml(opts) {
  const patientName = escHtml(opts.patientName || 'there');
  const title = escHtml(opts.appointmentTitle || 'Appointment');
  const dateStr = escHtml(opts.dateStr || fmtDate(opts.appointmentDate));
  const timeStr = escHtml(opts.timeStr || fmtTime(opts.appointmentTime));
  const staffName = escHtml(opts.staffName || '');
  const bizName = escHtml(opts.businessName || 'MySpark+');
  const rebookUrl = opts.rebookUrl || '';

  const rebookBlock = rebookUrl
    ? '<p style="margin:24px 0 4px"><a href="' + rebookUrl + '" style="background:#6b21ea;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600;font-size:14px">Book a new appointment</a></p>'
    : '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">To reschedule, reply to this email or give us a call.</p>';

  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">Appointment Cancelled</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + patientName + ', your appointment with ' + bizName + ' has been cancelled.</p>'
    + '<div style="text-align:center;font-size:20px;font-weight:700;color:#1a1030;margin:0 0 20px;padding:16px;background:#f7f5fc;border-radius:8px">' + title + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Date</td><td style="padding:8px 0;font-weight:600">' + dateStr + '</td></tr>'
    + (timeStr ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Time</td><td style="padding:8px 0;font-weight:600">' + timeStr + '</td></tr>' : '')
    + (staffName ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">With</td><td style="padding:8px 0;font-weight:600">' + staffName + '</td></tr>' : '')
    + '</table>'
    + rebookBlock
    + '<p style="color:#5a4d7a;font-size:14px;margin:24px 0 0">Thanks,<br>' + bizName + '</p>'
    + '</div>';
}

/**
 * @param {object} opts
 * @param {string} opts.subaccountId
 * @param {string} opts.subaccountSlug
 * @param {string} opts.recipientEmail
 * @param {string} opts.recipientName
 * @param {string} opts.contactId
 * @param {string} opts.businessName
 * @param {string} opts.appointmentTitle
 * @param {string} opts.appointmentDate     ISO or YYYY-MM-DD
 * @param {string} opts.appointmentTime     HH:MM
 * @param {string} [opts.staffName]
 * @param {string} [opts.rebookUrl]
 * @param {string} [opts.source]            'staff' | 'patient_self_serve'
 */
// Short, label-agnostic cancellation SMS. Footer is the dispatcher's job.
function buildCancelSmsBody(opts) {
  // HIPAA minimum-necessary: no service/title in SMS (see appointment-emails.js).
  const biz = opts.businessName || 'MySpark+';
  const dateStr = opts.dateStr || fmtDate(opts.appointmentDate);
  const timeStr = opts.timeStr || fmtTime(opts.appointmentTime);
  return biz + ': your appointment on ' + dateStr
    + (timeStr ? ' at ' + timeStr : '') + ' has been cancelled. Questions? Give us a call.';
}

async function sendCancellationEmail(opts) {
  if (!opts.subaccountId) return { ok: false, error: 'no subaccountId' };

  // Gate once, split per channel so email and SMS fire independently.
  const gate = await shouldSend(opts.subaccountId, 'appointment_cancellation', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'appointment_cancellation disabled' };
  const emailEnabled = !!gate.email_enabled;
  const smsEnabled = !!gate.sms_enabled;

  // SMS branch: independent of email. Fires when the channel is on and we have
  // a contact_id. Dispatcher resolves phone + consent + footer.
  if (smsEnabled && opts.contactId) {
    try {
      await sendPatientSms({
        subaccountId: opts.subaccountId,
        subaccountSlug: opts.subaccountSlug,
        typeKey: 'appointment_cancellation',
        contactId: opts.contactId,
        body: buildCancelSmsBody(opts),
        source: 'cancellation-' + (opts.source || 'staff')
      });
    } catch (e) {
      console.warn('cancellation SMS failed for contact', opts.contactId, ':', e.message);
    }
  }

  // Email branch: only when channel on and we have an address.
  if (!emailEnabled || !opts.recipientEmail) {
    return { ok: true, skipped: !emailEnabled ? 'email_off' : 'no_email', smsAttempted: smsEnabled && !!opts.contactId };
  }

  const html = buildHtml(opts);
  const subject = buildSubject(opts);

  try {
    const result = await sendEmail(opts.subaccountSlug, {
      scope: 'subaccount',
      source: 'cancellation-' + (opts.source || 'staff'),
      to: opts.recipientEmail,
      subject: subject,
      html: html,
      fromName: opts.businessName || 'MySpark+',
      templateType: 'appt-cancel',
      contactId: opts.contactId,
      vars: {
        contact_name: opts.recipientName || '',
        appointment_service: opts.appointmentTitle || '',
        appointment_date: opts.dateStr || fmtDate(opts.appointmentDate),
        appointment_time: opts.timeStr || fmtTime(opts.appointmentTime),
        business_name: opts.businessName || 'MySpark+'
      }
    });
    return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendCancellationEmail, buildHtml, buildSubject };
