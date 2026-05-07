// api/cron/subscriptions-charge.js (Lambda)
// Triggered daily by EventBridge OR manually invoked for testing.
//
// Picks all subscriptions where status='active' and next_due_date <= today,
// computes the per-cycle charge, processes Square Card on File charge,
// writes a payment record, and advances next_due_date.
//
// On failure: increments failed_charge_count. After 3 failures within 7 days,
// auto-suspends the subscription.
//
// Manual invoke payload:
//   { "sub_id": "sub-..." }  -- only process this one sub (skips date filter)
//   { "dry_run": true }      -- compute and log but don't charge or write
//
// Idempotency: source_id = sub-{id}-{next_due_date}. If the Lambda crashes
// mid-flow, the next run with the same key returns Square's original payment
// (no double-charge), allowing us to complete the DB writes.

const db = require('./lib/db');
const { getSquareCreds, squareHost, squareHeaders } = require('./lib/square');

// Auto-suspend after this many failed charges within the window
const SUSPEND_AFTER = 3;
const SUSPEND_WINDOW_DAYS = 7;

function intervalForCycle(cycle) {
  switch (cycle) {
    case 'weekly': return '7 days';
    case 'monthly': return '1 month';
    case 'quarterly': return '3 months';
    case 'annual': return '1 year';
    default: return '1 month';
  }
}

// Compute the charge breakdown for one subscription cycle.
// MUST match frontend calcSubTaxBreakdown() to ensure UI and actual charge align.
function computeCharge(sub, paySettings) {
  const tax = paySettings && paySettings.tax;
  const taxEnabled = !!(tax && tax.enabled && parseFloat(tax.rate) > 0);
  const taxRate = taxEnabled ? parseFloat(tax.rate) : 0;
  const taxLabel = (tax && tax.label) || 'Sales Tax';

  const isFirstCycle = !sub.last_charged_at;

  // Filter items: drop any with billingEndsAt in the past or present.
  // Stage 3.5 doesn't set billingEndsAt anywhere yet; this filter is forward-compat.
  const todayIso = new Date().toISOString().slice(0, 10);
  const itemsForCharge = (sub.items || []).filter(it => {
    if (!it.billingEndsAt) return true;
    return String(it.billingEndsAt).slice(0, 10) > todayIso;
  });

  let subtotal = 0;
  let afterDiscount = 0;
  let taxableAmount = 0;

  itemsForCharge.forEach(it => {
    const lineSticker = (parseFloat(it.price) || 0) * (it.qty || 1);
    subtotal += lineSticker;
    let line = lineSticker;
    if (it.discountType && (it.discountRecurring !== false || isFirstCycle)) {
      const dv = parseFloat(it.discountValue) || 0;
      if (it.discountType === 'pct') line -= line * dv / 100;
      else line -= dv;
      line = Math.max(0, line);
    }
    afterDiscount += line;
    if (it.taxable !== false) taxableAmount += line;
  });

  const discount = subtotal - afterDiscount;
  const taxAmount = taxEnabled ? Math.round(taxableAmount * taxRate / 100 * 100) / 100 : 0;
  const total = Math.round((afterDiscount + taxAmount) * 100) / 100;

  return {
    items: itemsForCharge,
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    afterDiscount: Math.round(afterDiscount * 100) / 100,
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
    const msg = errors.map(e => `${e.code}: ${e.detail || e.category}`).join('; ') || `HTTP ${res.status}`;
    return { ok: false, error: msg, status: res.status, raw: data };
  }
  return { ok: true, payment: data.payment };
}

async function writePaymentRecord(sub, contact, card, breakdown, squarePayment, ownerName) {
  const paymentId = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const last4 = (squarePayment && squarePayment.card_details && squarePayment.card_details.card && squarePayment.card_details.card.last_4) || card.last4 || null;
  const brand = (squarePayment && squarePayment.card_details && squarePayment.card_details.card && squarePayment.card_details.card.card_brand) || card.brand || null;
  const receiptUrl = (squarePayment && squarePayment.receipt_url) || null;

  await db.query(
    `INSERT INTO payments (
      id, subaccount_id,
      contact_id, contact_name,
      staff_id, staff_name, tip_staff_id,
      payment_type, payment_method, status,
      items, subtotal, after_discount, total,
      coupon_discount, coupon_code, coupon_id,
      discount_amount, discount_type, discount_val, discount_note,
      fee_amount, tax_amount, taxable_amount, tip_amount, credit_applied,
      gift_card_applied, refunded_amount,
      is_session_pack_sale, is_gift_card_sale,
      square_payment_id, square_receipt_url, card_last4, card_brand,
      subscription_id, notes,
      created_at, updated_at
    ) VALUES (
      $1, $2,
      $3, $4,
      $5, $6, NULL,
      'subscription', 'card_on_file', 'completed',
      $7::jsonb, $8, $9, $10,
      0, NULL, NULL,
      $11, NULL, NULL, $12,
      0, $13, $14, 0, 0,
      0, 0,
      FALSE, FALSE,
      $15, $16, $17, $18,
      $19, $20,
      NOW(), NOW()
    )
    ON CONFLICT (id) DO NOTHING`,
    [
      paymentId,                                                                  // 1
      sub.subaccount_id,                                                          // 2
      sub.contact_id,                                                             // 3
      (contact && contact.name) || null,                                          // 4
      sub.owner_user_id,                                                          // 5
      ownerName || null,                                                          // 6
      JSON.stringify(breakdown.items),                                            // 7
      breakdown.subtotal,                                                         // 8
      breakdown.afterDiscount,                                                    // 9
      breakdown.total,                                                            // 10
      breakdown.discount,                                                         // 11 discount_amount
      breakdown.discount > 0 ? 'Per-item discounts' : null,                       // 12 discount_note
      breakdown.taxAmount,                                                        // 13
      breakdown.taxableAmount,                                                    // 14
      squarePayment ? squarePayment.id : null,                                    // 15
      receiptUrl,                                                                 // 16
      last4,                                                                      // 17
      brand,                                                                      // 18
      sub.id,                                                                     // 19 subscription_id
      `Subscription cycle: ${sub.plan_name_snapshot || 'Subscription'}`           // 20 notes
    ]
  );

  return paymentId;
}

async function advanceSubAfterCharge(sub) {
  const interval = intervalForCycle(sub.billing_cycle);
  const todayIso = new Date().toISOString().slice(0, 10);
  // Drop any items whose billingEndsAt has passed
  const remainingItems = (sub.items || []).filter(it => {
    if (!it.billingEndsAt) return true;
    return String(it.billingEndsAt).slice(0, 10) > todayIso;
  });
  const newCyclePrice = remainingItems.reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (it.qty || 1), 0);

  await db.query(
    `UPDATE subscriptions
     SET last_charged_at = NOW(),
         next_due_date = next_due_date + INTERVAL '${interval}',
         items = $1::jsonb,
         cycle_price = $2,
         failed_charge_count = 0,
         last_failure_at = NULL,
         last_failure_reason = NULL,
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(remainingItems), newCyclePrice, sub.id]
  );
}

async function handleChargeFailure(sub, errMessage, breakdown) {
  // Count recent failures
  const r = await db.query(
    `SELECT COUNT(*) AS recent_failures
     FROM subscription_events
     WHERE subscription_id = $1
       AND event_type = 'charge_failed'
       AND created_at > NOW() - INTERVAL '${SUSPEND_WINDOW_DAYS} days'`,
    [sub.id]
  );
  const recentFailures = parseInt(r.rows[0].recent_failures, 10) || 0;
  const willSuspend = (recentFailures + 1) >= SUSPEND_AFTER;

  await db.query(
    `UPDATE subscriptions
     SET failed_charge_count = COALESCE(failed_charge_count, 0) + 1,
         last_failure_at = NOW(),
         last_failure_reason = $1,
         status = CASE WHEN $2 THEN 'suspended' ELSE status END,
         updated_at = NOW()
     WHERE id = $3`,
    [String(errMessage || '').slice(0, 500), willSuspend, sub.id]
  );

  await logEvent(sub, 'charge_failed', {
    error: errMessage,
    breakdown: breakdown || null,
    recent_failures: recentFailures + 1,
    auto_suspended: willSuspend
  });

  if (willSuspend) {
    await logEvent(sub, 'auto_suspended', {
      reason: `${recentFailures + 1} failed charges in ${SUSPEND_WINDOW_DAYS} days`,
      last_error: errMessage
    });
  }
}

async function logEvent(sub, eventType, metadata, paymentId) {
  await db.query(
    `INSERT INTO subscription_events (
      id, subscription_id, subaccount_id, event_type,
      actor_user_id, actor_type, payment_id, metadata, created_at
    ) VALUES ($1, $2, $3, $4, NULL, 'system', $5, $6::jsonb, NOW())`,
    [
      `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sub.id, sub.subaccount_id, eventType,
      paymentId || null, JSON.stringify(metadata || {})
    ]
  );
}

async function processSub(sub, blob, options) {
  const result = {
    sub_id: sub.id,
    contact_id: sub.contact_id,
    success: false,
    skipped: false,
    error: null
  };

  try {
    const data = blob.data || {};
    const paySettings = data.paySettings || {};

    const breakdown = computeCharge(sub, paySettings);
    result.breakdown = breakdown;
    result.cents = breakdown.cents;

    if (breakdown.cents <= 0) {
      result.skipped = true;
      result.reason = 'Total is zero, nothing to charge';
      if (!options.dry_run) {
        await advanceSubAfterCharge(sub);
        await logEvent(sub, 'charge_skipped', { reason: 'zero_total', breakdown });
      }
      return result;
    }

    const contacts = data.contacts || [];
    const contact = contacts.find(c => c && c.id === sub.contact_id);
    if (!contact) throw new Error('Contact not found in subaccount data');
    if (!contact.squareCustomerId) throw new Error('Contact has no Square customer ID');
    const card = (contact.squareCards || []).find(c => c && c.id === sub.card_id);
    if (!card) throw new Error('Card on file not found for this subscription');

    // Slug derivation: subaccount_id is "sub-{slug}". Strip the prefix.
    const slug = String(sub.subaccount_id || '').replace(/^sub-/, '');
    const creds = await getSquareCreds(slug);
    if (!creds || !creds.access_token) {
      throw new Error('Square is not connected for this workspace');
    }

    if (options.dry_run) {
      result.success = true;
      result.dry_run = true;
      result.would_charge_cents = breakdown.cents;
      console.log(`[DRY RUN] Sub ${sub.id}: would charge ${breakdown.cents} cents (${breakdown.total} USD)`);
      return result;
    }

    const idempotencyKey = `sub-${sub.id}-${String(sub.next_due_date).slice(0, 10)}`;
    const note = `Subscription cycle: ${sub.plan_name_snapshot || 'Subscription'}`;

    const charge = await chargeSquare({
      creds,
      customerId: contact.squareCustomerId,
      cardId: card.id,
      cents: breakdown.cents,
      idempotencyKey,
      note
    });

    if (!charge.ok) {
      await handleChargeFailure(sub, charge.error, breakdown);
      result.error = charge.error;
      result.square_status = charge.status;
      return result;
    }

    // Look up the owner's display name (best-effort)
    let ownerName = null;
    if (sub.owner_user_id) {
      try {
        const u = await db.query('SELECT display_name FROM subaccount_users WHERE id = $1', [sub.owner_user_id]);
        if (u.rows.length) ownerName = u.rows[0].display_name;
      } catch (_) { /* non-fatal */ }
    }

    const paymentId = await writePaymentRecord(sub, contact, card, breakdown, charge.payment, ownerName);
    await advanceSubAfterCharge(sub);
    await logEvent(sub, 'charge_succeeded', {
      payment_id: paymentId,
      square_payment_id: charge.payment.id,
      total: breakdown.total,
      tax: breakdown.taxAmount,
      breakdown
    }, paymentId);

    result.success = true;
    result.payment_id = paymentId;
    result.square_payment_id = charge.payment.id;
    return result;
  } catch (e) {
    result.error = e.message;
    if (!options.dry_run) {
      try { await handleChargeFailure(sub, e.message, result.breakdown); }
      catch (failErr) { console.error('handleChargeFailure also failed:', failErr.message); }
    }
    return result;
  }
}

exports.handler = async function (event) {
  const options = {};
  let subIdFilter = null;

  // EventBridge: bare event with no body. Manual invokes pass JSON.
  if (event && typeof event === 'object') {
    if (event.body) {
      try {
        const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        subIdFilter = b.sub_id || null;
        options.dry_run = !!b.dry_run;
      } catch (_) {}
    } else {
      subIdFilter = event.sub_id || null;
      options.dry_run = !!event.dry_run;
    }
  }

  const summary = {
    started_at: new Date().toISOString(),
    dry_run: !!options.dry_run,
    sub_id_filter: subIdFilter,
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: []
  };

  try {
    const sql = subIdFilter
      ? `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status = 'active' AND s.id = $1`
      : `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status = 'active' AND s.next_due_date <= CURRENT_DATE`;
    const params = subIdFilter ? [subIdFilter] : [];
    const r = await db.query(sql, params);
    summary.found = r.rows.length;

    for (const row of r.rows) {
      summary.processed++;
      const blob = { data: row.blob_data || {} };
      const sub = { ...row };
      delete sub.blob_data;
      const result = await processSub(sub, blob, options);
      if (result.success) summary.succeeded++;
      else if (result.skipped) summary.skipped++;
      else summary.failed++;
      summary.results.push(result);
    }

    summary.finished_at = new Date().toISOString();
    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    console.error('Cron error:', e.stack);
    summary.error = e.message;
    summary.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(summary, null, 2) };
  }
};
