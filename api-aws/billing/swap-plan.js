// api/billing/swap-plan.js (Lambda version)
//
// POST /api/billing/swap-plan
//
// Handles plan tier and billing period changes from the Manage Plan modal.
// Upgrades: immediate prorated charge.
// Downgrades and period changes: scheduled for next billing cycle.
//
// MIGRATED: Supabase REST → lib/db.js for plan, invoice queries.
//
// CHANGED 2026-05-07: TZ-aware. Proration days-remaining calc and the
// billing_period_start invoice field now use today in the subaccount's
// timezone, so Patrick at 11pm Eastern doesn't get a day of proration off.

const db = require('./lib/db');
const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('./lib/agency-billing');
const { sendError } = require('./lib/square');
const { logAudit } = require('./lib/audit');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz, getSubTimezone } = require('./lib/timezone');

const TIER_ORDER = { starter: 1, professional: 2, business: 3, enterprise: 4 };

function calcProration(oldTier, newTier, billingPeriod, hipaaAddon, nextBillingDate, discountPercent, todayLocal) {
  const oldCents = calculateCharge(oldTier, billingPeriod, hipaaAddon, discountPercent || 0);
  const newCents = calculateCharge(newTier, billingPeriod, hipaaAddon, discountPercent || 0);
  const totalDays = billingPeriod === 'annual' ? 365 : 30;
  // Day-count math in pure date space, anchored to today-in-TZ.
  const [ty, tm, td] = todayLocal.split('-').map(Number);
  const [ny, nm, nd] = String(nextBillingDate).slice(0, 10).split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const nextMs  = Date.UTC(ny, nm - 1, nd);
  const daysRemaining = Math.max(1, Math.ceil((nextMs - todayMs) / 86400000));
  const effectiveDays = Math.min(daysRemaining, totalDays);
  const oldDaily = oldCents / totalDays;
  const newDaily = newCents / totalDays;
  return Math.round((newDaily - oldDaily) * effectiveDays);
}

async function updatePlan(subaccountId, updates) {
  updates.updated_at = new Date().toISOString();
  await db.update('subaccount_plans', updates, { subaccount_id: subaccountId });
}

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId, newTier, newPeriod, newHipaa, newExempt, discountPercent, discountNote, customBillingDate } = req.body || {};

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;
  const actor = {
    actorType:     'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role
  };

  if (!subaccountId || !newTier || !newPeriod) {
    return sendError(res, 400, 'Missing required fields');
  }
  if (!TIER_ORDER[newTier]) return sendError(res, 400, 'Invalid tier: ' + newTier);
  if (!['monthly', 'annual'].includes(newPeriod)) return sendError(res, 400, 'Invalid period');

  try {
    let plan;
    try {
      plan = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
    } catch (e) {
      return sendError(res, 500, 'Could not load plan');
    }
    if (!plan) return sendError(res, 404, 'No plan found for ' + subaccountId);

    const subTz = await getSubTimezone(subaccountId, db);
    const todayLocal = todayInTz(subTz);

    const beforeSnapshot = {
      plan_tier: plan.plan_tier,
      billing_period: plan.billing_period,
      hipaa_addon: !!plan.hipaa_addon,
      exempt_from_billing: !!plan.exempt_from_billing,
      discount_percent: plan.discount_percent || 0,
      status: plan.status
    };

    // Exempt status change
    if (newExempt !== undefined && !!newExempt !== !!plan.exempt_from_billing) {
      const exemptUpdatePayload = {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        exempt_from_billing: !!newExempt,
        status: newExempt ? 'exempt' : 'trialing',
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      };
      if (!newExempt && customBillingDate) {
        exemptUpdatePayload.next_billing_date = customBillingDate;
        exemptUpdatePayload.status = 'active';
      }
      await updatePlan(subaccountId, exemptUpdatePayload);
      await logAudit({
        req, ...actor,
        action: 'agency.plan.exempt_changed',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            exempt_from_billing: !!newExempt,
            status: exemptUpdatePayload.status,
            next_billing_date: exemptUpdatePayload.next_billing_date || null
          }
        }
      });
      return res.status(200).json({ success: true, action: 'exempt_changed' });
    }

    if (plan.exempt_from_billing || newExempt) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: 'exempt_metadata_update',
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            discount_percent: discountPercent || 0
          }
        }
      });
      return res.status(200).json({ success: true, action: 'exempt_updated' });
    }

    if (plan.status === 'trialing') {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: 'trial_updated',
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            discount_percent: discountPercent || 0
          },
          trial_ends_at: plan.trial_ends_at || null
        }
      });
      return res.status(200).json({
        success: true,
        action: 'trial_updated',
        message: 'Plan updated. Card will be charged at the new tier when the trial ends.'
      });
    }

    const oldTier = plan.plan_tier;
    const oldPeriod = plan.billing_period;
    const isUpgrade = TIER_ORDER[newTier] > TIER_ORDER[oldTier];
    const isPeriodChange = newPeriod !== oldPeriod;
    const isTierChange = newTier !== oldTier;

    if (!isUpgrade) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: 'scheduled',
          is_tier_change: isTierChange,
          is_period_change: isPeriodChange,
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            discount_percent: discountPercent || 0
          }
        }
      });
      return res.status(200).json({
        success: true,
        action: 'scheduled',
        message: 'Plan change scheduled for next billing cycle.'
      });
    }

    // Upgrade: prorate and charge
    if (!plan.square_customer_id || !plan.square_card_id) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'No card on file',
        metadata: { path: 'upgrade_denied', before: beforeSnapshot, attempted_tier: newTier }
      });
      return sendError(res, 400, 'No card on file for this subaccount. Add a card via Manage Plan first.');
    }
    if (!plan.next_billing_date) {
      return sendError(res, 400, 'No billing date found. Cannot calculate proration.');
    }

    const proratedCents = calcProration(
      oldTier, newTier, oldPeriod, !!newHipaa,
      plan.next_billing_date,
      discountPercent || plan.discount_percent || 0,
      todayLocal
    );

    if (proratedCents <= 0) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: 'upgraded_no_charge',
          prorated_cents: proratedCents,
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            discount_percent: discountPercent || 0
          }
        }
      });
      return res.status(200).json({ success: true, action: 'upgraded_no_charge' });
    }

    const idempotencyKey = makeIdempotencyKey('up', subaccountId, todayLocal, oldTier, newTier);

    const chargeNote = 'MySpark+ upgrade: ' + oldTier + ' to ' + newTier + ' (prorated)';
    const result = await chargeCardOnFile(
      plan.square_customer_id,
      plan.square_card_id,
      proratedCents,
      chargeNote,
      idempotencyKey
    );

    await db.insertOne('subaccount_invoices', {
      subaccount_id: subaccountId,
      amount_cents: proratedCents,
      description: chargeNote,
      square_payment_id: result.success ? result.paymentId : null,
      status: result.success ? 'succeeded' : 'failed',
      failure_reason: result.success ? null : result.error,
      retry_attempt: 0,
      billing_period_start: todayLocal,
      billing_period_end: plan.next_billing_date,
      succeeded_at: result.success ? new Date().toISOString() : null,
      failed_at: result.success ? null : new Date().toISOString()
    });

    if (!result.success) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'failure',
        errorMessage: 'Card charge failed: ' + result.error,
        metadata: {
          path: 'upgrade_charge_failed',
          attempted_amount_cents: proratedCents,
          before: beforeSnapshot,
          attempted_tier: newTier
        }
      });
      return sendError(res, 402, 'Card charge failed: ' + result.error);
    }

    await updatePlan(subaccountId, {
      plan_tier: newTier,
      billing_period: newPeriod,
      hipaa_addon: !!newHipaa,
      status: 'active',
      discount_percent: discountPercent || 0,
      discount_note: discountNote || null
    });

    await logAudit({
      req, ...actor,
      action: 'agency.plan.swap',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: {
        path: 'upgraded',
        charged_cents: proratedCents,
        square_payment_id: result.paymentId,
        before: beforeSnapshot,
        after: {
          plan_tier: newTier,
          billing_period: newPeriod,
          hipaa_addon: !!newHipaa,
          discount_percent: discountPercent || 0
        }
      }
    });

    return res.status(200).json({
      success: true,
      action: 'upgraded',
      charged_cents: proratedCents,
      payment_id: result.paymentId
    });

  } catch (e) {
    console.error('swap-plan error:', e);
    await logAudit({
      req, ...actor,
      action: 'agency.plan.swap',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: e.message
    });
    return sendError(res, 500, 'Plan swap failed', e.message);
  }
}

exports.handler = wrap(handler);
