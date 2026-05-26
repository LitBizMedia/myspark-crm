// lib-aws/sub-charge.js
//
// Shared subscription charge logic used by:
//   - api/cron/subscriptions-charge.js  (daily cron)
//   - api/subaccount/subscriptions-create.js  (immediate charge on save when start_date <= today)
//
// processSub(sub, blob, options) is the entry point. Pass:
//   sub:  subscription row from RDS (with snake_case fields)
//   blob: { data: <subaccount_data.data JSONB> } - has paySettings + contacts
//   options: { dry_run?: boolean }
//
// On success returns { success: true, payment_id, square_payment_id, breakdown }.
// On failure returns { success: false, error, breakdown? }.
// Failures auto-suspend after SUSPEND_AFTER charges in SUSPEND_WINDOW_DAYS days.

const db = require('./db');
const recurringEmail = require('./recurring-billing-email');
const { getSquareCreds, squareHost, squareHeaders } = require('./square');
const { todayInTz, DEFAULT_TZ } = require('./timezone');
const { getContactById } = require('./contacts');
const { isLineTaxable } = require('./tax');

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

// MUST match frontend calcSubTaxBreakdown() so UI and actual charge align.
function computeCharge(sub, paySettings, tz) {
  const tax = paySettings && paySettings.tax;
  const taxEnabled = !!(tax && tax.enabled && parseFloat(tax.rate) > 0);
  const taxRate = taxEnabled ? parseFloat(tax.rate) : 0;
  const taxLabel = (tax && tax.label) || 'Sales Tax';

  const isFirstCycle = !sub.last_charged_at;
  const today = todayInTz(tz || DEFAULT_TZ);
  const itemsForCharge = (sub.items || []).filter(it => {
    if (!it.billingEndsAt) return true;
    return String(it.billingEndsAt).slice(0, 10) > today;
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
    // Subscriptions are per-item only (no section policy). The helper also
    // short-circuits if tax is globally disabled, matching existing gating.
    if (isLineTaxable(paySettings, 'subscription', it)) taxableAmount += line;
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

// Pending variant: writes a recurring subscription payment row with status='pending'
// and payment_method='other'. Used by the cron when a sub has no card on file
// (manual processing). Staff marks the payment as paid later via the transactions UI.
async function writePendingSubPayment(sub, contact, breakdown, ownerName) {
  const paymentId = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      'subscription', 'other', 'pending',
      $7::jsonb, $8, $9, $10,
      0, NULL, NULL,
      $11, NULL, NULL, $12,
      0, $13, $14, 0, 0,
      0, 0,
      FALSE, FALSE,
      NULL, NULL, NULL, NULL,
      $15, $16,
      NOW(), NOW()
    )
    ON CONFLICT (id) DO NOTHING`,
    [
      paymentId,
      sub.subaccount_id,
      sub.contact_id,
      (contact && contact.name) || null,
      sub.owner_user_id,
      ownerName || null,
      JSON.stringify(breakdown.items),
      breakdown.subtotal,
      breakdown.afterDiscount,
      breakdown.total,
      breakdown.discount,
      breakdown.discount > 0 ? 'Per-item discounts' : null,
      breakdown.taxAmount,
      breakdown.taxableAmount,
      sub.id,
      `Subscription cycle (manual processing): ${sub.plan_name_snapshot || 'Subscription'}`
    ]
  );

  return paymentId;
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
      paymentId,
      sub.subaccount_id,
      sub.contact_id,
      (contact && contact.name) || null,
      sub.owner_user_id,
      ownerName || null,
      JSON.stringify(breakdown.items),
      breakdown.subtotal,
      breakdown.afterDiscount,
      breakdown.total,
      breakdown.discount,
      breakdown.discount > 0 ? 'Per-item discounts' : null,
      breakdown.taxAmount,
      breakdown.taxableAmount,
      squarePayment ? squarePayment.id : null,
      receiptUrl,
      last4,
      brand,
      sub.id,
      `Subscription cycle: ${sub.plan_name_snapshot || 'Subscription'}`
    ]
  );

  return paymentId;
}

async function advanceSubAfterCharge(sub, tz) {
  const interval = intervalForCycle(sub.billing_cycle);
  const today = todayInTz(tz || DEFAULT_TZ);
  const remainingItems = (sub.items || []).filter(it => {
    if (!it.billingEndsAt) return true;
    return String(it.billingEndsAt).slice(0, 10) > today;
  });
  const newCyclePrice = remainingItems.reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (it.qty || 1), 0);

  // After a successful charge, status always becomes 'active'. This is the
  // transition point for trialing subs (trialing -> active on first charge).
  // Defensive WHERE clause: only update if status was active or trialing,
  // never accidentally resurrect a paused/suspended/cancelled sub.
  await db.query(
    `UPDATE subscriptions
     SET last_charged_at = NOW(),
         next_due_date = next_due_date + INTERVAL '${interval}',
         items = $1::jsonb,
         cycle_price = $2,
         status = 'active',
         failed_charge_count = 0,
         last_failure_at = NULL,
         last_failure_reason = NULL,
         updated_at = NOW()
     WHERE id = $3 AND status IN ('active', 'trialing')`,
    [JSON.stringify(remainingItems), newCyclePrice, sub.id]
  );
}

async function handleChargeFailure(sub, errMessage, breakdown) {
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

  // Fire patient notifications (non-fatal): payment_failed always, suspended if willSuspend.
  try {
    if (sub.contact_id) {
      const ctx = await recurringEmail._loadContext(sub.subaccount_id, sub.contact_id);
      if (ctx) {
        await recurringEmail.sendRecurringBillingEmail('payment_failed', Object.assign({}, ctx, {
          planName: sub.plan_name_snapshot || 'your subscription',
          amount: (breakdown && typeof breakdown.total === 'number') ? breakdown.total : (parseFloat(sub.cycle_price) || 0),
          billingCycle: sub.billing_cycle || '',
          nextDate: sub.next_due_date || null,
          reason: String(errMessage || '').slice(0, 200)
        }));
        if (willSuspend) {
          await recurringEmail.sendRecurringBillingEmail('suspended', Object.assign({}, ctx, {
            planName: sub.plan_name_snapshot || 'your subscription',
            amount: (breakdown && typeof breakdown.total === 'number') ? breakdown.total : (parseFloat(sub.cycle_price) || 0),
            billingCycle: sub.billing_cycle || ''
          }));
        }
      }
    }
  } catch (rbErr) {
    console.warn('recurring-billing payment_failed email failed (non-fatal):', rbErr.message);
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
  options = options || {};
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
    const tz = (data.settings && data.settings.timezone) || DEFAULT_TZ;

    const breakdown = computeCharge(sub, paySettings, tz);
    result.breakdown = breakdown;
    result.cents = breakdown.cents;

    if (breakdown.cents <= 0) {
      result.skipped = true;
      result.reason = 'Total is zero, nothing to charge';
      if (!options.dry_run) {
        await advanceSubAfterCharge(sub, tz);
        await logEvent(sub, 'charge_skipped', { reason: 'zero_total', breakdown });
      }
      return result;
    }

    // Manual processing: subs with no card_id are not auto-charged. Instead,
    // write a pending payment record so staff can mark it paid in the UI when
    // they collect cash/check/card manually. Advance next_due_date so the cron
    // moves on to the next cycle on its own.
    if (!sub.card_id) {
      result.success = true;
      result.deferred = true;
      result.reason = 'manual_processing';
      if (!options.dry_run) {
        const data = blob.data || {};
        const tz = (data.settings && data.settings.timezone) || DEFAULT_TZ;
        const contact = await getContactById(sub.subaccount_id, sub.contact_id);
        let ownerName = null;
        if (sub.owner_user_id) {
          try {
            const u = await db.query('SELECT display_name FROM subaccount_users WHERE id = $1', [sub.owner_user_id]);
            if (u.rows.length) ownerName = u.rows[0].display_name;
          } catch (_) { /* non-fatal */ }
        }
        const paymentId = await writePendingSubPayment(sub, contact, breakdown, ownerName);
        await advanceSubAfterCharge(sub, tz);
        await logEvent(sub, 'charge_deferred', {
          payment_id: paymentId,
          reason: 'manual_processing',
          total: breakdown.total,
          tax: breakdown.taxAmount,
          breakdown
        }, paymentId);
        result.payment_id = paymentId;
      }
      return result;
    }

    const contact = await getContactById(sub.subaccount_id, sub.contact_id);
    if (!contact) throw new Error('Contact not found');
    if (!contact.squareCustomerId) throw new Error('Contact has no Square customer ID');
    const card = (contact.squareCards || []).find(c => c && c.id === sub.card_id);
    if (!card) throw new Error('Card on file not found for this subscription');

    const slug = String(sub.subaccount_id || '').replace(/^sub-/, '');
    const creds = await getSquareCreds(slug);
    if (!creds || !creds.access_token) {
      throw new Error('Square is not connected for this workspace');
    }

    if (options.dry_run) {
      result.success = true;
      result.dry_run = true;
      result.would_charge_cents = breakdown.cents;
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

    let ownerName = null;
    if (sub.owner_user_id) {
      try {
        const u = await db.query('SELECT display_name FROM subaccount_users WHERE id = $1', [sub.owner_user_id]);
        if (u.rows.length) ownerName = u.rows[0].display_name;
      } catch (_) { /* non-fatal */ }
    }

    const paymentId = await writePaymentRecord(sub, contact, card, breakdown, charge.payment, ownerName);
    await advanceSubAfterCharge(sub, tz);
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
      catch (_) { /* non-fatal */ }
    }
    return result;
  }
}

module.exports = {
  intervalForCycle,
  computeCharge,
  chargeSquare,
  writePaymentRecord,
  advanceSubAfterCharge,
  handleChargeFailure,
  logEvent,
  processSub
};
