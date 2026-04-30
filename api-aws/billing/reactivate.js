// api/billing/reactivate.js (Lambda version)
//
// POST /api/billing/reactivate
//
// Reactivates a cancelled, suspended, or past_due subaccount.
//
// Smart charging:
//   - Cancelled within paid period: no charge, just restore status
//   - Otherwise: charge immediately for one billing cycle
//
// MIGRATED: Supabase REST → lib/db.js for plan, subaccount, invoice queries.

const db = require('./lib/db');
const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('./lib/agency-billing');
const { sendError } = require('./lib/square');
const { sendEmail } = require('./lib/billing-emails');
const { logAudit } = require('./lib/audit');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

function calcNextBillingDate(billingPeriod) {
  const d = new Date();
  if (billingPeriod === 'annual') {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId } = req.body || {};
  if (!subaccountId) return sendError(res, 400, 'subaccountId required');

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;
  const actor = {
    actorType:     'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role
  };

  try {
    // Load current plan
    let plan;
    try {
      plan = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
    } catch (e) {
      return sendError(res, 500, 'Could not load plan');
    }
    if (!plan) return sendError(res, 404, 'No plan found');

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
      await db.update('subaccounts',
        { active: true },
        { id: subaccountId }
      );

      await db.update('subaccount_plans',
        {
          status: 'active',
          canceled_at: null,
          updated_at: now
        },
        { subaccount_id: subaccountId }
      );

      try {
        const sub = await db.findOne('subaccounts',
          { id: subaccountId },
          { select: 'name, admin_email' }
        );
        if (sub && sub.admin_email) {
          await sendEmail(sub.admin_email, 'reactivation_no_charge', {
            subName: sub.name || subaccountId,
            nextBillingDate: plan.next_billing_date,
            planTier: plan.plan_tier
          });
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
    // CHARGED REACTIVATION
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

    await db.insertOne('subaccount_invoices', {
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

    await db.update('subaccounts',
      { active: true },
      { id: subaccountId }
    );

    await db.update('subaccount_plans',
      {
        status: 'active',
        next_billing_date: nextDate,
        current_period_start: now,
        last_charge_attempt_at: now,
        last_charge_status: 'succeeded',
        retry_count: 0,
        suspended_at: null,
        canceled_at: null,
        updated_at: now
      },
      { subaccount_id: subaccountId }
    );

    try {
      const sub = await db.findOne('subaccounts',
        { id: subaccountId },
        { select: 'name, admin_email' }
      );
      if (sub && sub.admin_email) {
        await sendEmail(sub.admin_email, 'reactivation_confirmed', {
          subName: sub.name || subaccountId,
          dollars,
          nextBillingDate: nextDate,
          planTier: plan.plan_tier
        });
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
}

exports.handler = wrap(handler);
