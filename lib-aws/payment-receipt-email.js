// lib-aws/payment-receipt-email.js
//
// Patient-facing payment receipt sender. Unified across 6 sources:
//   - pos               (default POS sale, no appointment/subscription/gc/sp)
//   - appointment       (appointment_id set, or class_session_id which collapses here)
//   - recurring_billing (payment_type='subscription')
//   - gift_card         (is_gift_card_sale=true)
//   - session_pack      (is_session_pack_sale=true)
//   - product           (reserved; current POS products flow as 'pos')
//
// Each source gets tailored HTML content (subject, hero line, table rows).
// Admin can toggle individual sources via source_filters_enabled JSONB on
// subaccount_notification_settings.
//
// Triggered from:
//   - api-aws/subaccount/payments-create.js (manual/frontend-initiated payments)
//   - lib-aws/sub-charge.js (cron-initiated recurring billing charges)

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');

function fmt$(n) {
  return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
}

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

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Detect the source of a payment row.
 * @param {object} pmt - payment row (snake_case from DB)
 * @returns {string} one of: pos, appointment, recurring_billing, gift_card, session_pack
 */
function detectSource(pmt) {
  if (pmt.is_gift_card_sale) return 'gift_card';
  if (pmt.is_session_pack_sale) return 'session_pack';
  if (pmt.payment_type === 'subscription' || pmt.subscription_id) return 'recurring_billing';
  if (pmt.appointment_id || pmt.class_session_id) return 'appointment';
  return 'pos';
}

function buildSubject(source, opts) {
  const total = fmt$(opts.total || 0);
  const biz = opts.businessName || 'MySpark+';

  switch (source) {
    case 'gift_card':         return 'Gift card receipt: ' + total + ' - ' + biz;
    case 'session_pack':      return 'Session pack receipt: ' + total + ' - ' + biz;
    case 'recurring_billing': return 'Subscription charge: ' + total + ' - ' + biz;
    case 'appointment':       return 'Appointment payment receipt: ' + total + ' - ' + biz;
    case 'pos':
    default:                  return 'Payment receipt: ' + total + ' - ' + biz;
  }
}

function buildHtml(source, opts) {
  const patientName = escHtml(opts.recipientName || 'there');
  const businessName = escHtml(opts.businessName || 'MySpark+');
  const total = fmt$(opts.total || 0);
  const date = escHtml(opts.paymentDate ? fmtDate(opts.paymentDate) : '');
  const method = escHtml(opts.paymentMethodLabel || opts.paymentMethod || '');
  const cardLast4 = escHtml(opts.cardLast4 || '');
  const cardBrand = escHtml(opts.cardBrand || '');

  // Hero line varies by source
  const heroByCsv = {
    pos: 'Hi ' + patientName + ', thanks for your payment to ' + businessName + '.',
    appointment: 'Hi ' + patientName + ', your appointment payment to ' + businessName + ' has been received.',
    recurring_billing: 'Hi ' + patientName + ', your subscription charge from ' + businessName + ' has been processed.',
    gift_card: 'Hi ' + patientName + ', thanks for your gift card purchase from ' + businessName + '.',
    session_pack: 'Hi ' + patientName + ', thanks for your session pack purchase from ' + businessName + '.'
  };
  const heroLine = heroByCsv[source] || heroByCsv.pos;

  // Build payment method display
  let methodDisplay = method;
  if (cardLast4 && cardBrand) {
    methodDisplay = cardBrand + ' ending in ' + cardLast4;
  } else if (cardLast4) {
    methodDisplay = 'Card ending in ' + cardLast4;
  }

  // Source-specific extra rows
  let extraRows = '';
  if (source === 'appointment' && opts.appointmentTitle) {
    extraRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">For</td><td style="padding:8px 0">' + escHtml(opts.appointmentTitle) + '</td></tr>';
  }
  if (source === 'recurring_billing' && opts.planName) {
    extraRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Subscription</td><td style="padding:8px 0">' + escHtml(opts.planName) + '</td></tr>';
  }
  if (source === 'gift_card' && opts.giftCardCode) {
    extraRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Gift card code</td><td style="padding:8px 0;font-family:monospace;font-weight:600">' + escHtml(opts.giftCardCode) + '</td></tr>';
  }
  if (source === 'session_pack' && opts.packName) {
    extraRows += '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Pack</td><td style="padding:8px 0">' + escHtml(opts.packName) + '</td></tr>';
  }

  // Tax line if present
  let taxRow = '';
  if (opts.taxAmount && parseFloat(opts.taxAmount) > 0) {
    taxRow = '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Tax</td><td style="padding:8px 0">' + fmt$(opts.taxAmount) + '</td></tr>';
  }

  // Tip line if present
  let tipRow = '';
  if (opts.tipAmount && parseFloat(opts.tipAmount) > 0) {
    tipRow = '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Tip</td><td style="padding:8px 0">' + fmt$(opts.tipAmount) + '</td></tr>';
  }

  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">Payment Received</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">' + heroLine + '</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
    + extraRows
    + (date ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Date</td><td style="padding:8px 0">' + date + '</td></tr>' : '')
    + (methodDisplay ? '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:160px">Payment method</td><td style="padding:8px 0">' + methodDisplay + '</td></tr>' : '')
    + taxRow
    + tipRow
    + '<tr><td style="padding:12px 0 8px;color:#5a4d7a;font-size:14px;width:160px;border-top:1px solid #e5e7eb">Total</td><td style="padding:12px 0 8px;font-weight:700;font-size:16px;border-top:1px solid #e5e7eb">' + total + '</td></tr>'
    + '</table>'
    + '<p style="color:#5a4d7a;font-size:13px;margin:0">Questions about this charge? Reply to this email or contact ' + businessName + ' directly.</p>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:24px 0 0">Thanks,<br>' + businessName + '</p>'
    + '</div>';
}

/**
 * Send a payment receipt to a patient.
 *
 * @param {object} opts
 * @param {object} opts.payment - payment row (snake_case from DB or camelCase)
 * @param {string} opts.subaccountId
 * @param {string} opts.subaccountSlug
 * @param {string} opts.recipientEmail
 * @param {string} opts.recipientName
 * @param {string} opts.contactId
 * @param {string} opts.businessName
 * @param {string} [opts.appointmentTitle]
 * @param {string} [opts.planName]
 * @param {string} [opts.giftCardCode]
 * @param {string} [opts.packName]
 */
async function sendPaymentReceipt(opts) {
  if (!opts.subaccountId) return { ok: false, error: 'no subaccountId' };
  if (!opts.recipientEmail) return { ok: true, skipped: true, reason: 'no recipient email' };

  const pmt = opts.payment || {};
  // Only send for completed payments
  const status = pmt.status || (opts.paymentStatus);
  if (status && status !== 'completed') {
    return { ok: true, skipped: true, reason: 'payment status=' + status + ', not completed' };
  }

  // Detect source from payment fields
  const source = detectSource(pmt);

  // Gate via Notifications tab. shouldSend returns source_filters_enabled
  // when the type has source_filters in catalog.
  const gate = await shouldSend(opts.subaccountId, 'payment_receipt', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'payment_receipt disabled' };

  // Source filter check
  if (gate.source_filters_enabled && gate.source_filters_enabled[source] === false) {
    return { ok: true, skipped: true, reason: 'source ' + source + ' disabled by admin' };
  }

  // Build the email
  const sendOpts = {
    total: parseFloat(pmt.total || pmt.amount || opts.total || 0),
    paymentDate: pmt.created_at || pmt.createdAt || opts.paymentDate || new Date().toISOString(),
    paymentMethod: pmt.payment_method || pmt.paymentMethod || '',
    cardLast4: pmt.card_last4 || pmt.cardLast4 || '',
    cardBrand: pmt.card_brand || pmt.cardBrand || '',
    taxAmount: pmt.tax_amount || pmt.taxAmount || 0,
    tipAmount: pmt.tip_amount || pmt.tipAmount || 0,
    recipientName: opts.recipientName,
    businessName: opts.businessName,
    appointmentTitle: opts.appointmentTitle,
    planName: opts.planName,
    giftCardCode: opts.giftCardCode || pmt.gift_card_code || pmt.giftCardCode || '',
    packName: opts.packName
  };

  const html = buildHtml(source, sendOpts);
  const subject = buildSubject(source, sendOpts);

  try {
    const result = await sendEmail(opts.subaccountSlug, {
      scope: 'subaccount',
      source: 'payment-receipt-' + source,
      to: opts.recipientEmail,
      subject: subject,
      html: html,
      fromName: opts.businessName || 'MySpark+',
      templateType: 'payment-receipt',
      contactId: opts.contactId,
      vars: {
        contact_name: opts.recipientName || '',
        contact_email: opts.recipientEmail,
        total: fmt$(sendOpts.total),
        business_name: opts.businessName || 'MySpark+',
        source: source
      }
    });
    return { ok: !!(result && result.ok), source: source, sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendPaymentReceipt, buildHtml, buildSubject, detectSource };
