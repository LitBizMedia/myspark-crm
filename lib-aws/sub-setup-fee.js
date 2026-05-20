// lib-aws/sub-setup-fee.js
//
// One-time setup fee charge for subscription enrollment or plan addition.
//
// Called by:
//   - api/subaccount/subscriptions-create.js  (charge before creating a new sub)
//   - api/subaccount/subscriptions-update.js  (charge before add_item on an existing sub)
//
// Per MySpark Payment Policy:
//   - Setup fees do NOT enter cycle_price (kept out of MRR)
//   - Setup fees go through the same tax path as recurring (per-item taxable flag,
//     paySettings.tax for rate/enabled)
//   - Setup fees are NOT multiplied by qty (one setup per plan enrollment)
//   - Payment record uses payment_type='setup_fee' so MRR queries filter it out
//
// chargeSetupFees(ctx) returns:
//   { success: true,  paymentId, squarePaymentId, breakdown }  on charge
//   { success: true,  skipped: true }                          when no items have setup fees
//   { success: false, error, breakdown? }                      on validation or Square error
//
// Callers MUST treat success=false as a hard stop. Do NOT proceed with sub
// creation or item addition if this returns failure.

const db = require('./db');
const { getSquareCreds, squareHost, squareHeaders } = require('./square');
const { getContactById } = require('./contacts');
const { isLineTaxable } = require('./tax');

// Build the breakdown for the setup fee charge. Mirrors sub-charge computeCharge
// shape so downstream code (payment record, audit logs) stays consistent.
//
// items: the sub's items array, each may carry setupFeeAmount (snapshot from plan)
// paySettings: from subaccount_data.data.paySettings
// Returns null if no items have a setup fee. Returns breakdown object otherwise.
function computeSetupFeeBreakdown(items, paySettings) {
  const tax = paySettings && paySettings.tax;
  const taxEnabled = !!(tax && tax.enabled && parseFloat(tax.rate) > 0);
  const taxRate = taxEnabled ? parseFloat(tax.rate) : 0;
  const taxLabel = (tax && tax.label) || 'Sales Tax';

  // Build setup-fee-only line items. One line per source item that has a setup fee.
  const feeLines = [];
  let subtotal = 0;
  let taxableAmount = 0;

  for (const it of items || []) {
    const fee = parseFloat(it.setupFeeAmount) || 0;
    if (fee <= 0) continue;

    // Setup fee inherits taxable flag from the source item. If the source item
    // is non-taxable (rare for plans, possible for custom items but custom items
    // never carry a setup fee anyway), the setup fee is non-taxable too.
    const taxable = it.taxable !== false;
    const line = {
      id: 'setupfee-' + (it.id || Date.now()),
      planId: it.planId || null,
      sourceItemId: it.id,
      name: 'Setup fee: ' + (it.name || 'Plan'),
      price: fee,
      qty: 1,
      taxable: taxable
    };
    feeLines.push(line);
    subtotal += fee;
    // Match recurring path: route through isLineTaxable for consistent gating.
    if (isLineTaxable(paySettings, 'subscription', line)) taxableAmount += fee;
  }

  if (feeLines.length === 0) return null;

  const taxAmount = taxEnabled ? Math.round(taxableAmount * taxRate / 100 * 100) / 100 : 0;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;

  return {
    items: feeLines,
    subtotal: Math.round(subtotal * 100) / 100,
    afterDiscount: Math.round(subtotal * 100) / 100,  // no discounts on setup fees
    taxableAmount: Math.round(taxableAmount * 100) / 100,
    taxAmount: taxAmount,
    taxRate: taxRate,
    taxLabel: taxLabel,
    total: total,
    cents: Math.round(total * 100)
  };
}

async function chargeSquare({ creds, customerId, cardId, cents, idempotencyKey, note }) {
  const url = 'https://' + squareHost(creds.sandbox) + '/v2/payments';
  const body = {
    source_id: cardId,
    customer_id: customerId,
    amount_money: { amount: cents, currency: 'USD' },
    idempotency_key: idempotencyKey,
    note: (note || '').slice(0, 500)
  };
  if (creds.location_id) body.location_id = creds.location_id;
  const res = await fetch(url, {
    method: 'POST',
    headers: squareHeaders(creds.access_token),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const errors = data.errors || [];
    const msg = errors.map(e => (e.code + ': ' + (e.detail || e.category))).join('; ') || ('HTTP ' + res.status);
    return { ok: false, error: msg, status: res.status, raw: data };
  }
  return { ok: true, payment: data.payment };
}

// Pending variant: writes a payment row with status='pending' and payment_method='other'.
// Used when there's no card on file and the customer will be billed manually.
// Caller must invoke this inside its own transaction.
async function writePendingSetupFeePayment(ctx, contact, breakdown, ownerName) {
  const paymentId = 'pay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const planNames = breakdown.items.map(it => it.name.replace(/^Setup fee:\s*/, '')).join(', ');
  const notesText = 'Setup fee (manual processing, pending collection): ' + planNames;

  await db.query(
    "INSERT INTO payments ("
    + "id, subaccount_id,"
    + "contact_id, contact_name,"
    + "staff_id, staff_name, tip_staff_id,"
    + "payment_type, payment_method, status,"
    + "items, subtotal, after_discount, total,"
    + "coupon_discount, coupon_code, coupon_id,"
    + "discount_amount, discount_type, discount_val, discount_note,"
    + "fee_amount, tax_amount, taxable_amount, tip_amount, credit_applied,"
    + "gift_card_applied, refunded_amount,"
    + "is_session_pack_sale, is_gift_card_sale,"
    + "square_payment_id, square_receipt_url, card_last4, card_brand,"
    + "subscription_id, notes,"
    + "created_at, updated_at"
    + ") VALUES ("
    + "$1, $2,"
    + "$3, $4,"
    + "$5, $6, NULL,"
    + "'setup_fee', 'other', 'pending',"
    + "$7::jsonb, $8, $9, $10,"
    + "0, NULL, NULL,"
    + "0, NULL, NULL, NULL,"
    + "0, $11, $12, 0, 0,"
    + "0, 0,"
    + "FALSE, FALSE,"
    + "NULL, NULL, NULL, NULL,"
    + "$13, $14,"
    + "NOW(), NOW()"
    + ") ON CONFLICT (id) DO NOTHING",
    [
      paymentId,
      ctx.subaccountId,
      ctx.contactId,
      (contact && contact.name) || null,
      ctx.ownerUserId || null,
      ownerName || null,
      JSON.stringify(breakdown.items),
      breakdown.subtotal,
      breakdown.afterDiscount,
      breakdown.total,
      breakdown.taxAmount,
      breakdown.taxableAmount,
      ctx.subId,
      notesText
    ]
  );

  return paymentId;
}

async function writeSetupFeePayment(ctx, contact, card, breakdown, squarePayment, ownerName) {
  const paymentId = 'pay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cardDetails = squarePayment && squarePayment.card_details && squarePayment.card_details.card;
  const last4 = (cardDetails && cardDetails.last_4) || card.last4 || null;
  const brand = (cardDetails && cardDetails.card_brand) || card.brand || null;
  const receiptUrl = (squarePayment && squarePayment.receipt_url) || null;

  // Notes string identifies which plans triggered the fee, useful for audit + refund UI.
  const planNames = breakdown.items.map(it => it.name.replace(/^Setup fee:\s*/, '')).join(', ');
  const notesText = 'Setup fee: ' + planNames;

  await db.query(
    "INSERT INTO payments ("
    + "id, subaccount_id,"
    + "contact_id, contact_name,"
    + "staff_id, staff_name, tip_staff_id,"
    + "payment_type, payment_method, status,"
    + "items, subtotal, after_discount, total,"
    + "coupon_discount, coupon_code, coupon_id,"
    + "discount_amount, discount_type, discount_val, discount_note,"
    + "fee_amount, tax_amount, taxable_amount, tip_amount, credit_applied,"
    + "gift_card_applied, refunded_amount,"
    + "is_session_pack_sale, is_gift_card_sale,"
    + "square_payment_id, square_receipt_url, card_last4, card_brand,"
    + "subscription_id, notes,"
    + "created_at, updated_at"
    + ") VALUES ("
    + "$1, $2,"
    + "$3, $4,"
    + "$5, $6, NULL,"
    + "'setup_fee', 'card_on_file', 'completed',"
    + "$7::jsonb, $8, $9, $10,"
    + "0, NULL, NULL,"
    + "0, NULL, NULL, NULL,"
    + "0, $11, $12, 0, 0,"
    + "0, 0,"
    + "FALSE, FALSE,"
    + "$13, $14, $15, $16,"
    + "$17, $18,"
    + "NOW(), NOW()"
    + ") ON CONFLICT (id) DO NOTHING",
    [
      paymentId,
      ctx.subaccountId,
      ctx.contactId,
      (contact && contact.name) || null,
      ctx.ownerUserId || null,
      ownerName || null,
      JSON.stringify(breakdown.items),
      breakdown.subtotal,
      breakdown.afterDiscount,
      breakdown.total,
      breakdown.taxAmount,
      breakdown.taxableAmount,
      squarePayment ? squarePayment.id : null,
      receiptUrl,
      last4,
      brand,
      ctx.subId,
      notesText
    ]
  );

  return paymentId;
}

// chargeSetupFees does the Square charge ONLY. It does not write a payment record.
// Callers must invoke writeSetupFeePayment separately, inside their own transaction
// if atomicity with subscription creation is required.
//
// Returns:
//   { success: true,  skipped: true, reason }                       no items with fees
//   { success: true,  squarePayment, breakdown, contact, card }     Square charge succeeded
//   { success: false, error, breakdown? }                           validation or Square error
async function chargeSetupFees(ctx) {
  const result = { success: false, skipped: false, error: null };

  try {
    if (!ctx || !ctx.subaccountId || !ctx.subId || !ctx.contactId) {
      throw new Error('chargeSetupFees: missing required context fields');
    }

    const breakdown = computeSetupFeeBreakdown(ctx.items || [], ctx.paySettings || {});
    if (!breakdown) {
      result.success = true;
      result.skipped = true;
      result.reason = 'No items with setup fees';
      return result;
    }
    result.breakdown = breakdown;
    result.cents = breakdown.cents;

    if (breakdown.cents <= 0) {
      result.success = true;
      result.skipped = true;
      result.reason = 'Setup fee total is zero';
      return result;
    }

    // No card on file: defer the charge. Setup fee creates a pending payment
    // record that staff marks paid later via the transactions UI.
    if (!ctx.cardId) {
      const contact = await getContactById(ctx.subaccountId, ctx.contactId);
      result.success = true;
      result.deferred = true;
      result.reason = 'manual_processing';
      result.contact = contact;
      return result;
    }

    const contact = await getContactById(ctx.subaccountId, ctx.contactId);
    if (!contact) throw new Error('Contact not found');
    if (!contact.squareCustomerId) throw new Error('Contact has no Square customer ID');
    const card = (contact.squareCards || []).find(c => c && c.id === ctx.cardId);
    if (!card) throw new Error('Card on file not found for this subscription');

    const slug = String(ctx.subaccountId || '').replace(/^sub-/, '');
    const creds = await getSquareCreds(slug);
    if (!creds || !creds.access_token) throw new Error('Square is not connected for this workspace');

    const idempotencyTag = ctx.idempotencyTag || 'create';
    const idempotencyKey = 'setupfee-' + ctx.subId + '-' + idempotencyTag;
    const note = 'Setup fee for subscription ' + ctx.subId;

    const charge = await chargeSquare({
      creds,
      customerId: contact.squareCustomerId,
      cardId: card.id,
      cents: breakdown.cents,
      idempotencyKey,
      note
    });

    if (!charge.ok) {
      result.error = charge.error;
      result.squareStatus = charge.status;
      return result;
    }

    result.success = true;
    result.squarePayment = charge.payment;
    result.contact = contact;
    result.card = card;
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

module.exports = {
  computeSetupFeeBreakdown,
  chargeSetupFees,
  writeSetupFeePayment,
  writePendingSetupFeePayment
};
