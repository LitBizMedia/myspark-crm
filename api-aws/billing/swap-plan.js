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
const { chargeCardOnFile, makeIdempotencyKey } = require('./lib/agency-billing');
const pricing = require('./lib/plan-pricing');
const { sendError } = require('./lib/square');
const { logAudit } = require('./lib/audit');
const agencyEmails = require('./lib/agency-emails');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz, getSubTimezone } = require('./lib/timezone');

const TIER_ORDER = { starter: 1, professional: 2, business: 3, enterprise: 4 };

// Proration delegates to canonical pricing helper, which handles both tier
// AND HIPAA add-on changes via getTotalPrice(). Uses current_period_start
// (the actual cycle anchor) instead of next_billing_date for elapsed-day calc.
async function calcProration(plan, newTier, newPeriod, newHipaa, discountPercent, todayLocal) {
  // Anchor: prefer current_period_start (the actual cycle start);
  // fall back to next_billing_date minus period_days if missing.
  let periodStart = plan.current_period_start;
  if (!periodStart && plan.next_billing_date) {
    const days = pricing.daysInPeriod(plan.billing_period);
    const next = new Date(String(plan.next_billing_date).slice(0,10));
    periodStart = new Date(next.getTime() - days * 86400000).toISOString();
  }
  if (!periodStart) periodStart = new Date().toISOString();

  const r = await pricing.calculateProration({
    currentTier: plan.plan_tier,
    currentBillingPeriod: plan.billing_period,
    currentHipaa: !!plan.hipaa_addon,
    newTier: newTier,
    newBillingPeriod: newPeriod,
    newHipaa: !!newHipaa,
    currentPeriodStart: periodStart,
    discountPercent: discountPercent || 0,
    asOfDate: todayLocal
  });

  return r.finalChargeCents;
}

async function updatePlan(subaccountId, updates) {
  updates.updated_at = new Date().toISOString();
  await db.update('subaccount_plans', updates, { subaccount_id: subaccountId });
}

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId, newTier, newPeriod, newHipaa, newExempt, discountPercent, discountNote, customBillingDate, customPriceCents } = req.body || {};

  const auth = await requireAgencyAdmin(req, res);
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

    // Flat custom-price override resolution (Option 1): the override is bound to a
    // specific tier+period deal. If THIS save changes tier or period, the override
    // clears (re-quote required). Otherwise the incoming override value is written
    // as-is. Exempt toggles preserve it (handled by passing resolvedCustomPrice,
    // which only nulls on a tier/period change in the same save).
    // Normalize: '' / undefined -> null (no override); a number -> integer cents.
    let incomingCustom = null;
    if (customPriceCents !== null && customPriceCents !== undefined && customPriceCents !== ''
        && !isNaN(customPriceCents)) {
      incomingCustom = Math.max(0, Math.round(Number(customPriceCents)));
    }
    const _tierOrPeriodChanged = (newTier !== plan.plan_tier) || (newPeriod !== plan.billing_period);
    const resolvedCustomPrice = _tierOrPeriodChanged ? null : incomingCustom;

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
      const goingExempt = !!newExempt;
      const exemptUpdatePayload = {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        exempt_from_billing: goingExempt,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null,
        custom_price_cents: resolvedCustomPrice
      };

      if (goingExempt) {
        // Billed -> Exempt: stop billing, clear pending changes (no point queuing for an exempt account)
        exemptUpdatePayload.status = 'exempt';
        exemptUpdatePayload.pending_plan_tier = null;
        exemptUpdatePayload.pending_billing_period = null;
        exemptUpdatePayload.pending_hipaa_addon = null;
        exemptUpdatePayload.pending_change_effective_at = null;
        exemptUpdatePayload.pending_change_note = null;
      } else {
        // Exempt -> Billed: NO trial. Bills on customBillingDate, or today if blank.
        // Card must already exist on file.
        if (!plan.square_customer_id || !plan.square_card_id) {
          return sendError(res, 400, 'No card on file. Add a card before removing exempt status.');
        }
        const billingDate = customBillingDate || todayLocal;
        exemptUpdatePayload.status = 'active';
        exemptUpdatePayload.next_billing_date = billingDate;
        exemptUpdatePayload.current_period_start = billingDate;
        // No trial fields - clear any old ones
        exemptUpdatePayload.trial_ends_at = null;
      }

      await updatePlan(subaccountId, exemptUpdatePayload);
      await logAudit({
        req, ...actor,
        action: goingExempt ? 'agency.subaccount.exempt_added' : 'agency.subaccount.exempt_removed',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          before: beforeSnapshot,
          after: {
            plan_tier: newTier,
            billing_period: newPeriod,
            hipaa_addon: !!newHipaa,
            exempt_from_billing: goingExempt,
            status: exemptUpdatePayload.status,
            next_billing_date: exemptUpdatePayload.next_billing_date || null
          },
          first_billing_date_used: !goingExempt ? (customBillingDate || todayLocal) : null,
          billing_date_source: !goingExempt ? (customBillingDate ? 'admin_provided' : 'today_default') : null
        }
      });
      return res.status(200).json({
        success: true,
        action: goingExempt ? 'exempt_added' : 'exempt_removed',
        message: goingExempt
          ? 'Workspace is now exempt from billing.'
          : ('Billing starts on ' + (customBillingDate || todayLocal) + '.')
      });
    }

    if (plan.exempt_from_billing || newExempt) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null,
        custom_price_cents: resolvedCustomPrice
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
        discount_note: discountNote || null,
        custom_price_cents: resolvedCustomPrice
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
    const isTierChange = newTier !== oldTier;
    const isPeriodChange = newPeriod !== oldPeriod;
    const isHipaaChange = !!newHipaa !== !!plan.hipaa_addon;

    // Classify by price delta (handles tier, period, HIPAA in one shot)
    const cls = await pricing.classifyChange({
      currentTier: oldTier,
      currentBillingPeriod: oldPeriod,
      currentHipaa: !!plan.hipaa_addon,
      newTier: newTier,
      newBillingPeriod: newPeriod,
      newHipaa: !!newHipaa
    });
    const isUpgrade = cls.type === 'upgrade';
    const isDowngrade = cls.type === 'downgrade';

    if (!isUpgrade) {
      // Downgrades and same-price swaps: set pending_* fields. Cron applies at next_billing_date.
      // Discount note + discount_percent can change immediately (no charge impact this cycle).
      const updates = {
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null,
        custom_price_cents: resolvedCustomPrice
      };
      // If this is actually a downgrade or other change, queue it as pending.
      const hasChange = isTierChange || isPeriodChange || isHipaaChange;
      if (hasChange) {
        updates.pending_plan_tier = newTier;
        updates.pending_billing_period = newPeriod;
        updates.pending_hipaa_addon = !!newHipaa;
        updates.pending_change_effective_at = plan.next_billing_date || null;
        updates.pending_change_note = (isDowngrade ? 'Downgrade' : 'Change') + ' scheduled by ' + (auth.username || 'admin');
      }
      await updatePlan(subaccountId, updates);

      // Send scheduled-change email (best-effort)
      try {
        const subRow = await db.findOne('subaccounts', { id: subaccountId }, { select: 'name, admin_email' });
        if (subRow && subRow.admin_email && hasChange) {
          await agencyEmails.sendEmail(subRow.admin_email, 'plan_change_scheduled', {
            subName: subRow.name || subaccountId,
            oldPlan: (plan.plan_tier || '') + (plan.billing_period ? ' ' + plan.billing_period : ''),
            newPlan: newTier + (newPeriod ? ' ' + newPeriod : ''),
            effectiveDate: plan.next_billing_date ? String(plan.next_billing_date).slice(0, 10) : 'next billing date',
            subaccountId: subaccountId
          });
        }
      } catch (emailErr) {
        console.error('swap-plan: scheduled email failed:', emailErr.message);
      }

      await logAudit({
        req, ...actor,
        action: isDowngrade ? 'agency.subaccount.plan_downgrade_scheduled' : 'agency.plan.swap',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: hasChange ? 'pending_change_set' : 'metadata_only',
          is_tier_change: isTierChange,
          is_period_change: isPeriodChange,
          is_hipaa_change: isHipaaChange,
          classification: cls.type,
          price_delta_cents: cls.priceDelta,
          effective_at: updates.pending_change_effective_at || null,
          before: beforeSnapshot,
          after: hasChange ? {
            pending_plan_tier: newTier,
            pending_billing_period: newPeriod,
            pending_hipaa_addon: !!newHipaa,
            discount_percent: discountPercent || 0
          } : {
            discount_percent: discountPercent || 0
          }
        }
      });
      return res.status(200).json({
        success: true,
        action: hasChange ? 'scheduled' : 'metadata_updated',
        message: hasChange
          ? ('Plan change scheduled for ' + (updates.pending_change_effective_at || 'next billing date') + '.')
          : 'Settings updated.'
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

    const proratedCents = await calcProration(
      plan, newTier, newPeriod, !!newHipaa,
      discountPercent || plan.discount_percent || 0,
      todayLocal
    );

    if (proratedCents <= 0) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null,
        custom_price_cents: resolvedCustomPrice
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
      discount_note: discountNote || null,
      custom_price_cents: resolvedCustomPrice,
      // Upgrade overrides any prior pending downgrade
      pending_plan_tier: null,
      pending_billing_period: null,
      pending_hipaa_addon: null,
      pending_change_effective_at: null,
      pending_change_note: null
    });

    // Send upgrade receipt email (best-effort)
    try {
      const subRow = await db.findOne('subaccounts', { id: subaccountId }, { select: 'name, admin_email' });
      if (subRow && subRow.admin_email) {
        await agencyEmails.sendEmail(subRow.admin_email, 'plan_changed_upgrade', {
          subName: subRow.name || subaccountId,
          oldPlan: oldTier + (plan.billing_period ? ' ' + plan.billing_period : ''),
          newPlan: newTier + (newPeriod ? ' ' + newPeriod : ''),
          prorationAmount: proratedCents ? (proratedCents / 100).toFixed(2) : null,
          nextBillingDate: plan.next_billing_date ? String(plan.next_billing_date).slice(0, 10) : null,
          billingPeriod: newPeriod,
          subaccountId: subaccountId
        });
      }
    } catch (emailErr) {
      console.error('swap-plan: upgrade email failed:', emailErr.message);
    }

    await logAudit({
      req, ...actor,
      action: 'agency.subaccount.plan_upgrade',
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
