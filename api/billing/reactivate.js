// api/billing/reactivate.js
// Reactivates a cancelled, suspended, or past_due subaccount.
//
// Smart charging:
//   - Cancelled within paid period (next_billing_date still in the future):
//       no charge, just restore status to active and re-enable the subaccount.
//       Customer already paid for the current period.
//   - Cancelled and the period has expired, OR suspended, OR past_due:
//       charge immediately for one billing cycle and start a fresh period.

const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');
const { sendEmail } = require('../../lib/billing-emails');
const { logAudit, extractActorFromBody } = require('../../lib/audit');

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

  const actor = extractActorFromBody(req.body);

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
      await logAudit({
        req, ...actor,
        action: 'agency.plan.reactivate',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'Account status is "' + plan.status + '", not reactivatable'
      });
      return sendError(res, 400, 'Account status is "' + plan.status + '". Only suspended, cancelled, or past_due accounts can be reactivated.');
    }

    const now = new Date().toISOString();
    const today = new Date().toISOString().split('T')[0];

    // ─────────────────────────────────────────────────────
    // GRACEFUL REACTIVATION (cancelled, period still active)
    // ─────────────────────────────────────────────────────
    const periodStillActive = plan.next_billing_date && plan.next_billing_date > today;

    if (plan.status === 'cancelled' && periodStillActive) {

      await fetch(
        SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId,
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ active: true })
        }
      );

      await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({
            status: 'active',
            canceled_at: null,
            updated_at: now
          })
        }
      );

      try {
        const subRes = await fetch(
          SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId + '&select=name,admin_email',
          { headers: sbHeaders() }
        );
        if (subRes.ok) {
          const subRows = await subRes.json();
          if (subRows && subRows.length && subRows[0].admin_email) {
            await sendEmail(subRows[0].admin_email, 'reactivation_no_charge', {
              subName: subRows[0].name || subaccountId,
              nextBillingDate: plan.next_billing_date,
              planTier: plan.plan_tier
            });
          }
        }
      } catch (emailErr) {
        console.error('reactivate.js (no charge): email send failed:', emailErr.message);
      }

      await logAudit({
        req, ...actor,
        action: 'agency.plan.reactivate',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          path: 'graceful',
          charged_cents: 0,
          plan_tier: plan.plan_tier,
          billing_period: plan.billing_period,
          next_billing_date: plan.next_billing_date,
          previous_status: 'cancelled'
        }
      });

      return res.status(200).json({
        success: true,
        charged_cents: 0,
        no_charge: true,
        next_billing_date: plan.next_billing_date,
        message: 'Subscription resumed. No charge: still within paid period until ' + plan.next_billing_date + '.'
      });
    }

    // ─────────────────────────────────────────────────────
    // CHARGED REACTIVATION (suspended, past_due, expired)
    // ─────────────────────────────────────────────────────
    if (!plan.square_customer_id || !plan.square_card_id) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.reactivate',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'No card on file'
      });
      return sendError(res, 400, 'No card on file. Cannot reactivate without a payment method.');
    }

    const amountCents = calculateCharge(
      plan.plan_tier,
      plan.billing_period,
      plan.hipaa_addon,
      plan.discount_percent || 0
    );
    const dollars     = (amountCents / 100).toFixed(2);
    const chargeNote  = 'MySpark+ reactivation: ' + plan.plan_tier + ' (' + plan.billing_period + ')';
    const idempotencyKey = makeIdempotencyKey('rea', subaccountId, today);

    const result = await chargeCardOnFile(
      plan.square_customer_id,
      plan.square_card_id,
      amountCents,
      chargeNote,
      idempotencyKey
    );

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
        billing_period_start: today,
        billing_period_end: nextDate,
        succeeded_at: result.success ? new Date().toISOString() : null,
        failed_at: result.success ? null : new Date().toISOString()
      })
    });

    if (!result.success) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.reactivate',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'failure',
        errorMessage: 'Card charge failed: ' + result.error,
        metadata: {
          path: 'charged',
          attempted_amount_cents: amountCents,
          plan_tier: plan.plan_tier,
          previous_status: plan.status
        }
      });
      return sendError(res, 402, 'Card charge failed: ' + result.error);
    }

    await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ active: true })
      }
    );

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

    try {
      const subRes = await fetch(
        SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId + '&select=name,admin_email',
        { headers: sbHeaders() }
      );
      if (subRes.ok) {
        const subRows = await subRes.json();
        if (subRows && subRows.length && subRows[0].admin_email) {
          await sendEmail(subRows[0].admin_email, 'reactivation_confirmed', {
            subName: subRows[0].name || subaccountId,
            dollars,
            nextBillingDate: nextDate,
            planTier: plan.plan_tier
          });
        }
      }
    } catch (emailErr) {
      console.error('reactivate.js: email send failed:', emailErr.message);
    }

    await logAudit({
      req, ...actor,
      action: 'agency.plan.reactivate',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: {
        path: 'charged',
        charged_cents: amountCents,
        square_payment_id: result.paymentId,
        plan_tier: plan.plan_tier,
        billing_period: plan.billing_period,
        next_billing_date: nextDate,
        previous_status: plan.status
      }
    });

    return res.status(200).json({
      success: true,
      charged_cents: amountCents,
      no_charge: false,
      payment_id: result.paymentId,
      next_billing_date: nextDate
    });

  } catch (e) {
    console.error('reactivate error:', e);
    await logAudit({
      req, ...actor,
      action: 'agency.plan.reactivate',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: e.message
    });
    return sendError(res, 500, 'Reactivation failed', e.message);
  }
};
