// lib-aws/contract-signed-email.js
//
// Patient-facing confirmation email after they sign a contract. Includes
// the signed PDF as an attachment if generation succeeded.
//
// Triggered from api-aws/contracts/contracts-public.js after the signing
// UPDATE commits. Gates via shouldSend('contract_signed').

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');
const { sendPatientSms } = require('./patient-sms');

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '';
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch (e) { return String(d); }
}

function buildSubject(opts) {
  return 'Signed: ' + (opts.contractTitle || 'Your contract');
}

function buildHtml(opts) {
  const title = escHtml(opts.contractTitle || 'Your contract');
  const businessName = escHtml(opts.businessName || 'MySpark+');
  const signedAtFormatted = escHtml(formatDate(opts.signedAt));
  const envelopeId = escHtml(opts.envelopeId || '');
  const hasPdfAttachment = !!opts.hasPdfAttachment;

  const pdfNote = hasPdfAttachment
    ? '<p style="margin:0 0 16px;color:#5a4d7a;font-size:13px;line-height:1.6">A signed PDF copy is attached to this email for your records.</p>'
    : '<p style="margin:0 0 16px;color:#5a4d7a;font-size:13px;line-height:1.6">Your signed copy is stored securely with ' + businessName + '.</p>';

  return ''
    + '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">'
    + '<tr><td align="center"><table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">'
    + '<tr><td style="padding:24px 32px;background:#10b981;color:#ffffff">'
    + '<div style="font-size:14px;opacity:.85;margin-bottom:4px">Signed and confirmed</div>'
    + '<div style="font-size:20px;font-weight:700">' + title + '</div>'
    + '</td></tr>'
    + '<tr><td style="padding:28px 32px">'
    + '<p style="margin:0 0 16px;color:#1a1030;font-size:14px;line-height:1.6">Thank you for signing <strong>' + title + '</strong> with ' + businessName + '.</p>'
    + (signedAtFormatted ? '<p style="margin:0 0 20px;color:#5a4d7a;font-size:14px;line-height:1.6">Signed on <strong>' + signedAtFormatted + '</strong>.</p>' : '')
    + pdfNote
    + (envelopeId ? '<p style="margin:0;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:18px">Document ID: <code style="font-family:Menlo,monospace;font-size:11px">' + envelopeId + '</code></p>' : '')
    + '</td></tr>'
    + '</table></td></tr></table>';
}

/**
 * Send a signed-contract confirmation to the patient.
 *
 * @param {object} opts
 * @param {string} opts.subaccountId
 * @param {string} opts.subaccountSlug
 * @param {string} opts.recipientEmail
 * @param {string} opts.contactId
 * @param {string} opts.businessName
 * @param {string} opts.contractTitle
 * @param {Date|string} opts.signedAt
 * @param {string} opts.envelopeId
 * @param {Buffer} [opts.pdfBuffer]  Signed PDF buffer for attachment (optional)
 */
async function sendContractSignedEmail(opts) {
  if (!opts.subaccountId) return { ok: false, error: 'no subaccountId' };

  // Gate once, split per channel so email and SMS fire independently. A signed
  // confirmation is a notification (not a delivery), so independence is fine here.
  const gate = await shouldSend(opts.subaccountId, 'contract_signed', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'contract_signed disabled' };
  const emailEnabled = !!gate.email_enabled;
  const smsEnabled = !!gate.sms_enabled;

  // SMS branch: independent, fires on the channel flag + a contact. No document
  // title (could carry meaning); confirms receipt, points to email for the copy.
  if (smsEnabled && opts.contactId) {
    try {
      const biz = opts.businessName || 'MySpark+';
      const smsBody = biz + ': thanks, we received your signed document. A copy is in your email.';
      await sendPatientSms({
        subaccountId: opts.subaccountId,
        subaccountSlug: opts.subaccountSlug,
        typeKey: 'contract_signed',
        contactId: opts.contactId,
        body: smsBody,
        source: 'contract-signed'
      });
    } catch (e) {
      console.warn('contract signed SMS failed for contact', opts.contactId, ':', e.message);
    }
  }

  // Email branch: only when channel on and we have an address.
  if (!emailEnabled || !opts.recipientEmail) {
    return { ok: true, skipped: !emailEnabled ? 'email_off' : 'no_email', smsAttempted: smsEnabled && !!opts.contactId };
  }

  const hasPdfAttachment = !!(opts.pdfBuffer && opts.pdfBuffer.length);
  const html = buildHtml({
    contractTitle: opts.contractTitle,
    businessName: opts.businessName,
    signedAt: opts.signedAt,
    envelopeId: opts.envelopeId,
    hasPdfAttachment
  });
  const subject = buildSubject({ contractTitle: opts.contractTitle });

  const emailOpts = {
    scope: 'subaccount',
    source: 'contract-signed',
    to: opts.recipientEmail,
    subject: subject,
    html: html,
    fromName: opts.businessName || 'MySpark+',
    templateType: 'contract-signed',
    contactId: opts.contactId
  };

  if (hasPdfAttachment) {
    emailOpts.attachments = [{
      filename: 'signed-contract.pdf',
      content: opts.pdfBuffer,
      contentType: 'application/pdf'
    }];
  }

  try {
    const result = await sendEmail(opts.subaccountSlug, emailOpts);
    return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendContractSignedEmail, buildHtml, buildSubject };
