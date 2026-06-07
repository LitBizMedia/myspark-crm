// lib-aws/gift-card-purchase-email.js
//
// Sends a digital gift card to its recipient (or the buyer if no recipient
// email is set). Standalone and context-agnostic: callable from the POS issue
// path today and from a future public gift-card catalog/widget without change.
//
// Fires AFTER the payment transaction commits. Non-fatal: email failures never
// roll back the sale or the card.
//
// Gate: shouldSend(subaccountId, 'gift_card_purchase', db). Default catalog
// state is enabled for email.
//
// Routing (per catalog design): recipientEmail if set, otherwise the buyer's
// email. If neither exists, skip (nothing to send to).

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');

function fmt$(n) {
  return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
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
  var businessName = escHtml(opts.businessName || 'MySpark+');
  var recipName = escHtml(opts.recipientName || 'there');
  var code = escHtml(opts.code || '');
  var balance = fmt$(opts.balance);
  var productName = escHtml(opts.productName || 'Gift Card');
  var terms = opts.terms ? escHtml(opts.terms) : '';

  var termsBlock = terms
    ? '<tr><td style="padding:16px 0 0 0;color:#5a4d7a;font-size:12px;line-height:1.5">' + terms + '</td></tr>'
    : '';

  return (
    '<div style="max-width:520px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#1a1030">' +
      '<div style="padding:24px 0;text-align:center">' +
        '<div style="font-size:20px;font-weight:700;color:#1a1030">' + businessName + '</div>' +
      '</div>' +
      '<div style="background:linear-gradient(135deg,#6b21ea,#ff4000);border-radius:14px;padding:28px 24px;text-align:center;color:#fff">' +
        '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.9">' + productName + '</div>' +
        '<div style="font-size:40px;font-weight:800;margin:10px 0">' + balance + '</div>' +
        '<div style="font-size:12px;opacity:.85;margin-bottom:6px">Gift card code</div>' +
        '<div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:.12em;background:rgba(255,255,255,.18);border-radius:8px;padding:10px 14px;display:inline-block">' + code + '</div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:20px">' +
        '<tr><td style="padding:4px 0;font-size:15px">Hi ' + recipName + ',</td></tr>' +
        '<tr><td style="padding:8px 0;font-size:15px;line-height:1.5">You have a gift card from ' + businessName + ' worth <strong>' + balance + '</strong>. Present the code above when you book or check out.</td></tr>' +
        termsBlock +
      '</table>' +
      '<div style="padding:24px 0;text-align:center;color:#5a4d7a;font-size:12px">Sent by ' + businessName + ' via MySpark+</div>' +
    '</div>'
  );
}

function buildText(opts) {
  var businessName = opts.businessName || 'MySpark+';
  var balance = fmt$(opts.balance);
  var code = opts.code || '';
  var productName = opts.productName || 'Gift Card';
  return (
    businessName + ' - ' + productName + '\n\n' +
    'You have a gift card worth ' + balance + '.\n' +
    'Code: ' + code + '\n\n' +
    'Present this code when you book or check out.\n\n' +
    'Sent by ' + businessName + ' via MySpark+'
  );
}

// opts: { subaccountId, code, balance, recipientName, recipientEmail,
//         buyerEmail, buyerName, productName, terms, businessName, slug }
async function sendGiftCardPurchase(opts) {
  opts = opts || {};
  if (!opts.subaccountId) return { ok: false, skipped: true, reason: 'no_subaccount' };

  const gate = await shouldSend(opts.subaccountId, 'gift_card_purchase', db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason };
  if (!gate.email_enabled) return { ok: true, skipped: true, reason: 'email_channel_off' };

  // Route: recipient email if set, otherwise buyer email.
  const to = (opts.recipientEmail && opts.recipientEmail.trim())
    || (opts.buyerEmail && opts.buyerEmail.trim())
    || '';
  if (!to) return { ok: true, skipped: true, reason: 'no_deliverable_email' };

  // If sending to the buyer (no recipient set), greet by buyer name.
  const recipientName = (opts.recipientEmail && opts.recipientEmail.trim())
    ? opts.recipientName
    : (opts.buyerName || opts.recipientName);

  const html = buildHtml({
    businessName: opts.businessName,
    recipientName: recipientName,
    code: opts.code,
    balance: opts.balance,
    productName: opts.productName,
    terms: opts.terms
  });
  const text = buildText({
    businessName: opts.businessName,
    code: opts.code,
    balance: opts.balance,
    productName: opts.productName
  });

  const subject = 'Your ' + (opts.businessName || 'gift card') + ' gift card';

  try {
    await sendEmail(opts.slug || opts.subaccountId, {
      scope: 'subaccount',
      source: 'system',
      internal: true, // transactional one-way delivery; not a patient thread
      to: to,
      subject: subject,
      html: html,
      text: text,
      fromName: opts.businessName || 'MySpark+',
      templateType: 'gift-card-purchase'
    });
    return { ok: true, sent: true, to: to };
  } catch (e) {
    console.error('gift-card-purchase-email send failed:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = { sendGiftCardPurchase };
