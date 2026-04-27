// api/billing/swap-plan.js
// Handles plan tier and billing period changes from the Manage Plan modal.
// Upgrades: immediate prorated charge for remaining days in current period.
// Downgrades and period changes: take effect at next billing cycle, no charge now.

const { chargeCardOnFile, calculateCharge, PLAN_PRICES_CENTS, HIPAA_ADDON_CENTS } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIER_ORDER = { starter: 1, professional: 2, business: 3, enterprise: 4 };

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function calcProration(oldTier, newTier, billingPeriod, hipaaAddon, nextBillingDate) {
  const oldCents = calculateCharge(oldTier, billingPeriod, hipaaAddon);
  const newCents = calculateCharge(newTier, billingPeriod, hipaaAddon);
  const totalDays = billingPeriod === 'annual' ? 365 : 30;
  const today = new Date();
  const nextDate = new Date(nextBillingDate);
  const daysRemaining = Math.max(1, Math.ceil((nextDate - today) / 86400000));
  const effectiveDays = Math.min(daysRemaining, totalDays);
  const oldDaily = oldCents / totalDays;
  const newDaily = newCents / totalDays;
  return Math.round((newDaily - oldDaily) * effectiveDays);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId, newTier, newPeriod, newHipaa, newExempt, discountPercent, discountNote } = req.body || {};

  if (!subaccountId || !newTier || !newPeriod) {
    return sendError(res, 400, 'Missing required fields');
  }
  if (!TIER_ORDER[newTier]) return sendError(res, 400, 'Invalid tier: ' + newTier);
  if (!['monthly', 'annual'].includes(newPeriod)) return sendError(res, 400, 'Invalid period');

  try {
    // Load current plan
    const planRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId + '&select=*',
      { headers: sbHeaders() }
    );
    if (!planRes.ok) return sendError(res, 500, 'Could not load plan');
    const plans = await planRes.json();
    if (!plans || !plans.length) return sendError(res, 404, 'No plan found for ' + subaccountId);
    const plan = plans[0];

    // Handle exempt flag changes
    if (newExempt !== undefined && !!newExempt !== !!plan.exempt_from_billing) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        exempt_from_billing: !!newExempt,
        status: newExempt ? 'exempt' : 'trialing'
      });
      return res.status(200).json({ success: true, action: 'exempt_changed' });
    }

    if (plan.exempt_from_billing || newExempt) {
      // Exempt accounts: just update the DB record, no billing
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      return res.status(200).json({ success: true, action: 'exempt_updated' });
    }

    const oldTier = plan.plan_tier;
    const oldPeriod = plan.billing_period;
    const isUpgrade = TIER_ORDER[newTier] > TIER_ORDER[oldTier];
    const isPeriodChange = newPeriod !== oldPeriod;
    const isTierChange = newTier !== oldTier;

    // Downgrade or period-only change: schedule for next cycle
    if (!isUpgrade) {
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa,
        discount_percent: discountPercent || 0,
        discount_note: discountNote || null
      });
      return res.status(200).json({
        success: true,
        action: 'scheduled',
        message: 'Plan change scheduled for next billing cycle.'
      });
    }

    // Upgrade: calculate proration and charge immediately
    if (!plan.square_customer_id || !plan.square_card_id) {
      return sendError(res, 400, 'No card on file for this subaccount. Add a card via Manage Plan first.');
    }
    if (!plan.next_billing_date) {
      return sendError(res, 400, 'No billing date found. Cannot calculate proration.');
    }

    const proratedCents = calcProration(oldTier, newTier, oldPeriod, !!newHipaa, plan.next_billing_date);

    if (proratedCents <= 0) {
      // Edge case: no charge needed (e.g. same effective rate)
      await updatePlan(subaccountId, {
        plan_tier: newTier,
        billing_period: newPeriod,
        hipaa_addon: !!newHipaa
      });
      return res.status(200).json({ success: true, action: 'upgraded_no_charge' });
    }

    const chargeNote = 'MySpark+ upgrade: ' + oldTier + ' to ' + newTier + ' (prorated)';
    const result = await chargeCardOnFile(
      plan.square_customer_id,
      plan.square_card_id,
      proratedCents,
      chargeNote
    );

    // Log to invoices
    await fetch(SUPABASE_URL + '/rest/v1/subaccount_invoices', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        subaccount_id: subaccountId,
        amount_cents: proratedCents,
        description: chargeNote,
        square_payment_id: result.success ? result.paymentId : null,
        status: result.success ? 'succeeded' : 'failed',
        failure_reason: result.success ? null : result.error,
        retry_attempt: 0,
        billing_period_start: new Date().toISOString().split('T')[0],
        billing_period_end: plan.next_billing_date,
        succeeded_at: result.success ? new Date().toISOString() : null,
        failed_at: result.success ? null : new Date().toISOString()
      })
    });

    if (!result.success) {
      return sendError(res, 402, 'Card charge failed: ' + result.error);
    }

    // Charge succeeded: update plan
    await updatePlan(subaccountId, {
      plan_tier: newTier,
      billing_period: newPeriod,
      hipaa_addon: !!newHipaa,
      status: 'active'
    });

    return res.status(200).json({
      success: true,
      action: 'upgraded',
      charged_cents: proratedCents,
      payment_id: result.paymentId
    });

  } catch (e) {
    console.error('swap-plan error:', e);
    return sendError(res, 500, 'Plan swap failed', e.message);
  }
};

async function updatePlan(subaccountId, updates) {
  updates.updated_at = new Date().toISOString();
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
    { method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(updates) }
  );
  if (!res.ok) throw new Error('Plan update failed: ' + await res.text());
}
