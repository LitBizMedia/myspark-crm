// lib-aws/refund-email.js
//
// Sends a refund receipt to the patient after a refund is processed by
// api-aws/subaccount/payment-refund.js. Uses lib/mailgun for transport.
//
// Fires after the refund transaction commits successfully. Non-fatal:
// email failures do not roll back the refund.
//
// Gate: requires subaccount admin to have refund_receipt enabled in the
// Notifications tab (subaccount_notification_settings RDS row). Default
// catalog state is enabled for email.

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');
const { sendPatientSms } = require('./patient-sms');

function fmt$(n) {
  return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
}

function fmtDate(d) {
  if (!d) return '';
  try {
    var dt = (typeof d === 'string') ? new Date(d) : d;
    return dt.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  } catch (e) { return String(d); }
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(opts) {
  var patientName = opts.patientName || 'there';
  var businessName = opts.businessName || 'MySpark+';
  var refundTotal = opts.refundTotal;
  var cardPortion = opts.cardPortion || 0;
  var gcPortion = opts.giftCardPortion || 0;
  var reason = opts.reason || '';
  var originalDate = opts.originalDate;
  var originalTotal = opts.originalTotal;
  var newStatus = opts.newStatus;
  var isFull = newStatus === 'refunded';

  var methodRows = '';
  if (cardPortion > 0) {
    methodRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">To card</td><td style="padding:8px 0;font-weight:600">' + fmt$(cardPortion) + '</td></tr>';
  }
  if (gcPortion > 0) {
    methodRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Gift card restored</td><td style="padding:8px 0;font-weight:600">' + fmt$(gcPortion) + '</td></tr>';
  }

  var originalRow = '';
  if (originalDate && originalTotal != null) {
    originalRow =
      '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Original payment</td>' +
      '<td style="padding:8px 0">' + fmt$(originalTotal) + ' on ' + fmtDate(originalDate) + '</td></tr>';
  }

  var reasonRow = '';
  if (reason && reason.trim()) {
    reasonRow =
      '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px;vertical-align:top">Reason</td>' +
      '<td style="padding:8px 0">' + escHtml(reason.trim()) + '</td></tr>';
  }

  var heading = isFull ? 'Refund Processed' : 'Partial Refund Processed';
  var intro = 'Hi ' + escHtml(patientName) + ', your refund of ' + fmt$(refundTotal) + ' has been processed by ' + escHtml(businessName) + '.';
  var cardNote = cardPortion > 0
    ? '<p style="color:#5a4d7a;font-size:14px;margin:16px 0 0">Refunds to a card typically appear on your statement within 5-10 business days, depending on your card issuer.</p>'
    : '';

  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">' + heading + '</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">' + intro + '</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Refund amount</td><td style="padding:8px 0;font-weight:600;font-size:16px">' + fmt$(refundTotal) + '</td></tr>'
    + methodRows
    + originalRow
    + reasonRow
    + '</table>'
    + cardNote
    + '<p style="color:#5a4d7a;font-size:14px;margin:24px 0 0">Thanks,<br>' + escHtml(businessName) + '</p>'
    + '</div>';
}

/**
 * Send a refund receipt to a patient.
 * @param {object} opts
 * @param {string} opts.subaccountId - 'sub-xxx' format
 * @param {string} opts.subaccountSlug - subaccount slug (no 'sub-' prefix)
 * @param {string} opts.recipientEmail - patient email
 * @param {string} opts.recipientName - patient name
 * @param {string} opts.contactId - contact id (for email_log)
 * @param {string} opts.businessName - clinic name
 * @param {number} opts.refundTotal
 * @param {number} opts.cardPortion
 * @param {number} opts.giftCardPortion
 * @param {string} opts.reason
 * @param {string} opts.originalDate - ISO date string
 * @param {number} opts.originalTotal
 * @param {string} opts.newStatus - 'refunded' | 'partial_refund'
 * @returns {Promise<{ok: boolean, sent?: number, skipped?: boolean, reason?: string}>}
 */
async function sendRefundReceipt(opts) {
  if (!opts.subaccountId) return { ok: false, error: 'no subaccountId' };

  // Gate once, split per channel so email and SMS fire independently.
  const gate = await shouldSend(opts.subaccountId, 'refund_receipt', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'refund_receipt disabled' };
  const emailEnabled = !!gate.email_enabled;
  const smsEnabled = !!gate.sms_enabled;

  // SMS branch: independent of email. Body is GC-aware so it never tells a
  // patient to watch a statement for money that went back to a gift card.
  // Amount via fmt$ per Payment Policy; names nothing (HIPAA minimal).
  if (smsEnabled && opts.contactId) {
    try {
      const card = parseFloat(opts.cardPortion || 0);
      const gc = parseFloat(opts.giftCardPortion || 0);
      const biz = opts.businessName || 'MySpark+';
      const amt = fmt$(opts.refundTotal);
      let tail;
      if (card <= 0 && gc > 0) {
        tail = ' has been added back to your gift card.';
      } else {
        tail = ' has been processed. It may take a few days to appear on your statement.';
      }
      const smsBody = biz + ': your refund of ' + amt + tail;
      await sendPatientSms({
        subaccountId: opts.subaccountId,
        subaccountSlug: opts.subaccountSlug,
        typeKey: 'refund_receipt',
        contactId: opts.contactId,
        body: smsBody,
        source: 'refund'
      });
    } catch (e) {
      console.warn('refund SMS failed for contact', opts.contactId, ':', e.message);
    }
  }

  // Email branch: only when channel on and we have an address.
  if (!emailEnabled || !opts.recipientEmail) {
    return { ok: true, skipped: !emailEnabled ? 'email_off' : 'no_email', smsAttempted: smsEnabled && !!opts.contactId };
  }

  const html = buildHtml({
    patientName: opts.recipientName,
    businessName: opts.businessName,
    refundTotal: opts.refundTotal,
    cardPortion: opts.cardPortion,
    giftCardPortion: opts.giftCardPortion,
    reason: opts.reason,
    originalDate: opts.originalDate,
    originalTotal: opts.originalTotal,
    newStatus: opts.newStatus
  });

  const subject = (opts.newStatus === 'refunded' ? 'Refund processed: ' : 'Partial refund processed: ')
    + fmt$(opts.refundTotal);

  try {
    const result = await sendEmail(opts.subaccountSlug, {
      scope: 'subaccount',
      source: 'refund',
      to: opts.recipientEmail,
      subject: subject,
      html: html,
      fromName: opts.businessName || 'MySpark+',
      templateType: 'refund-receipt',
      contactId: opts.contactId,
      vars: {
        contact_name: opts.recipientName || '',
        contact_email: opts.recipientEmail,
        refund_total: fmt$(opts.refundTotal),
        business_name: opts.businessName || 'MySpark+'
      }
    });
    return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Expose builder for preview Lambda
function buildSubject(opts) {
  return (opts.newStatus === 'refunded' ? 'Refund processed: ' : 'Partial refund processed: ')
    + fmt$(opts.refundTotal);
}

module.exports = { sendRefundReceipt, buildHtml, buildSubject };
