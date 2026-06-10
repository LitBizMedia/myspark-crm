// lib-aws/class-enrollment-email.js
//
// Confirms class registration to a patient. Fires from class-sessions-enroll
// on a genuine enroll (not cancel, not waitlist). Gates via
// shouldSend('class_enrollment'). Email and SMS fire independently per channel.
//
// Wording is class-native: never "appointment". Email (protected channel) may
// name the class; SMS (unprotected) is HIPAA-minimal and names no class title.
// Non-fatal: a send failure never blocks enrollment.

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
  const title = opts.classTitle || 'your class';
  const dateStr = opts.dateStr || fmtDate(opts.classDate);
  return "You're registered: " + title + (dateStr ? ' on ' + dateStr : '');
}

function buildHtml(opts) {
  const patientName = escHtml(opts.recipientName || 'there');
  const bizName = escHtml(opts.businessName || 'MySpark+');
  const title = escHtml(opts.classTitle || 'your class');
  const dateStr = escHtml(opts.dateStr || fmtDate(opts.classDate));
  const timeStr = escHtml(opts.timeStr || fmtTime(opts.classTime));
  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">You are registered</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + patientName + ', you are all set for your class with ' + bizName + '.</p>'
    + '<div style="text-align:center;font-size:20px;font-weight:700;color:#1a1030;margin:0 0 20px;padding:16px;background:#f7f5fc;border-radius:8px">' + title + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Date</td><td style="padding:8px 0;font-weight:600">' + dateStr + '</td></tr>'
    + (timeStr ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:100px">Time</td><td style="padding:8px 0;font-weight:600">' + timeStr + '</td></tr>' : '')
    + '</table>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0">See you there! To make changes, give us a call.</p>'
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
 * @param {string} opts.classTitle
 * @param {string} opts.classDate   YYYY-MM-DD or ISO
 * @param {string} opts.classTime   HH:MM
 */
async function sendClassEnrollmentEmail(opts) {
  if (!opts.subaccountId) return { ok: false, error: 'no subaccountId' };

  // Gate once, split per channel so email and SMS fire independently.
  const gate = await shouldSend(opts.subaccountId, 'class_enrollment', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'class_enrollment disabled' };
  const emailEnabled = !!gate.email_enabled;
  const smsEnabled = !!gate.sms_enabled;

  const dateStr = opts.dateStr || fmtDate(opts.classDate);
  const timeStr = opts.timeStr || fmtTime(opts.classTime);

  // SMS branch: HIPAA-minimal, no class title. Class-native wording.
  if (smsEnabled && opts.contactId) {
    try {
      const biz = opts.businessName || 'MySpark+';
      const smsBody = biz + ": you're registered for your class on " + dateStr
        + (timeStr ? ' at ' + timeStr : '') + '. See you there!';
      await sendPatientSms({
        subaccountId: opts.subaccountId,
        subaccountSlug: opts.subaccountSlug,
        typeKey: 'class_enrollment',
        contactId: opts.contactId,
        body: smsBody,
        source: 'class-enrollment'
      });
    } catch (e) {
      console.warn('class enrollment SMS failed for contact', opts.contactId, ':', e.message);
    }
  }

  // Email branch: only when channel on and we have an address.
  if (!emailEnabled || !opts.recipientEmail) {
    return { ok: true, skipped: !emailEnabled ? 'email_off' : 'no_email', smsAttempted: smsEnabled && !!opts.contactId };
  }

  try {
    const result = await sendEmail(opts.subaccountSlug, {
      scope: 'subaccount',
      source: 'class-enrollment',
      to: opts.recipientEmail,
      subject: buildSubject({ classTitle: opts.classTitle, classDate: opts.classDate, dateStr }),
      html: buildHtml({
        recipientName: opts.recipientName,
        businessName: opts.businessName,
        classTitle: opts.classTitle,
        classDate: opts.classDate,
        classTime: opts.classTime,
        dateStr, timeStr
      }),
      fromName: opts.businessName || 'MySpark+',
      templateType: 'class-enrollment',
      contactId: opts.contactId,
      vars: {
        contact_name: opts.recipientName || '',
        class_title: opts.classTitle || '',
        class_date: dateStr,
        class_time: timeStr,
        business_name: opts.businessName || 'MySpark+'
      }
    });
    return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendClassEnrollmentEmail, buildHtml, buildSubject };
