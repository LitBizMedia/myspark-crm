// api/billing/reactivate.js
// Reactivates a suspended or cancelled subaccount.
// Charges the card immediately for one billing cycle, sets next_billing_date,
// re-enables the subaccount, and resets retry count.

const { chargeCardOnFile, calculateCharge } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function calcNextBillingDate(billingPeriod) {
  const d = new Date();
  if (billingPeriod === 'annual') {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId } = req.body || {};
  if (!subaccountId) return sendError(res, 400, 'subaccountId required');

  try {
    // Load current plan
    const planRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId + '&select=*',
      { headers: sbHeaders() }
    );
    if (!planRes.ok) return sendError(res, 500, 'Could not load plan');
    const plans = await planRes.json();
    if (!plans || !plans.length) return sendError(res, 404, 'No plan found');
    const plan = plans[0];

    const reactivatableStatuses = ['suspended', 'cancelled', 'past_due'];
    if (!reactivatableStatuses.includes(plan.status)) {
      return sendError(res, 400, 'Account status is "' + plan.status + '". Only suspended, cancelled, or past_due accounts can be reactivated.');
    }
    if (!plan.square_customer_id || !plan.square_card_id) {
      return sendError(res, 400, 'No card on file. Cannot reactivate without a payment method.');
    }

    // Charge immediately for one billing cycle
    const amountCents = calculateCharge(plan.plan_tier, plan.billing_period, plan.hipaa_addon);
    const chargeNote = 'MySpark+ reactivation: ' + plan.plan_tier + ' (' + plan.billing_period + ')';

    const result = await chargeCardOnFile(
      plan.square_customer_id,
      plan.square_card_id,
      amountCents,
      chargeNote
    );

    // Log invoice
    const nextDate = calcNextBillingDate(plan.billing_period);
    await fetch(SUPABASE_URL + '/rest/v1/subaccount_invoices', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        subaccount_id: subaccountId,
        amount_cents: amountCents,
        description: chargeNote,
        square_payment_id: result.success ? result.paymentId : null,
        status: result.success ? 'succeeded' : 'failed',
        failure_reason: result.success ? null : result.error,
        retry_attempt: 0,
        billing_period_start: new Date().toISOString().split('T')[0],
        billing_period_end: nextDate,
        succeeded_at: result.success ? new Date().toISOString() : null,
        failed_at: result.success ? null : new Date().toISOString()
      })
    });

    if (!result.success) {
      return sendError(res, 402, 'Card charge failed: ' + result.error);
    }

    const now = new Date().toISOString();

    // Re-enable subaccount
    await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ active: true })
      }
    );

    // Reset plan to active
    await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({
          status: 'active',
          next_billing_date: nextDate,
          current_period_start: now,
          last_charge_attempt_at: now,
          last_charge_status: 'succeeded',
          retry_count: 0,
          suspended_at: null,
          canceled_at: null,
          updated_at: now
        })
      }
    );

    return res.status(200).json({
      success: true,
      charged_cents: amountCents,
      payment_id: result.paymentId,
      next_billing_date: nextDate
    });

  } catch (e) {
    console.error('reactivate error:', e);
    return sendError(res, 500, 'Reactivation failed', e.message);
  }
};
