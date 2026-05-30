// api/billing/suspend.js (Lambda version)
//
// POST /api/billing/suspend
//
// Manually suspend or unsuspend a subaccount.
// Different from cancel (which keeps access until next_billing_date).
// Suspended = immediate lockout, subaccounts.active = false.
//
// Body: { subaccountId, action: 'suspend' | 'unsuspend' }

const db = require('./lib/db');
const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('./lib/agency-billing');
const { sendError } = require('./lib/square');
const { logAudit } = require('./lib/audit');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz, getSubTimezone } = require('./lib/timezone');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId, action, mode } = req.body || {};
  if (!subaccountId) return sendError(res, 400, 'subaccountId required');
  if (action !== 'suspend' && action !== 'unsuspend') {
    return sendError(res, 400, 'action must be "suspend" or "unsuspend"');
  }

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;
  const actor = {
    actorType:     'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role
  };

  try {
    let plan;
    try {
      plan = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
    } catch (e) {
      return sendError(res, 500, 'Could not load plan');
    }
    if (!plan) return sendError(res, 404, 'No plan found');

    // Exempt accounts CAN be suspended (locks users out of platform; no billing impact either way).

    const now = new Date().toISOString();
    const previousStatus = plan.status;

    if (action === 'suspend') {
      if (plan.status === 'suspended') {
        return sendError(res, 400, 'Account is already suspended.');
      }
      if (plan.status === 'cancelled') {
        return sendError(res, 400, 'Cannot suspend a cancelled account. Reactivate first.');
      }
      try {
        await db.update('subaccount_plans',
          {
            status: 'suspended',
            suspended_at: now,
            updated_at: now
          },
          { subaccount_id: subaccountId }
        );
        await db.update('subaccounts', { active: false }, { id: subaccountId });
      } catch (e) {
        return sendError(res, 500, 'Suspend failed: ' + e.message);
      }

      await logAudit({
        req, ...actor,
        action: 'agency.subaccount.suspend',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          previous_status: previousStatus,
          plan_tier: plan.plan_tier,
          reason: 'manual_admin_suspend'
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Subaccount suspended. Admin and staff are locked out until you unsuspend.',
        new_status: 'suspended'
      });

    } else {
      // unsuspend
      if (plan.status !== 'suspended') {
        return sendError(res, 400, 'Account is not suspended.');
      }

      const chargeNow = mode === 'charge_now';
      let chargeAttempted = false;
      let chargeSucceeded = false;
      let chargeResult = null;
      let newStatus = 'active';

      // Restore subaccount access first (lock-out reversed regardless of charge outcome)
      try {
        await db.update('subaccounts', { active: true }, { id: subaccountId });
      } catch (e) {
        return sendError(res, 500, 'Unsuspend failed (subaccount update): ' + e.message);
      }

      if (chargeNow && plan.square_customer_id && plan.square_card_id && !plan.exempt_from_billing) {
        // Attempt the charge that originally failed
        chargeAttempted = true;
        const amountCents = calculateCharge(
          plan.plan_tier,
          plan.billing_period,
          plan.hipaa_addon,
          plan.discount_percent || 0
        );
        const tz = await getSubTimezone(subaccountId, db);
        const todayLocal = todayInTz(tz);
        const chargeNote = 'MySpark+ ' + plan.plan_tier + ' (' + plan.billing_period + ') - manual unsuspend';
        const idempotencyKey = makeIdempotencyKey('unsuspend', subaccountId, todayLocal, 'r0');

        chargeResult = await chargeCardOnFile(
          plan.square_customer_id,
          plan.square_card_id,
          amountCents,
          chargeNote,
          idempotencyKey
        );

        if (chargeResult.success) {
          chargeSucceeded = true;
          newStatus = 'active';
          // Write invoice
          await db.insertOne('subaccount_invoices', {
            subaccount_id: subaccountId,
            amount_cents: amountCents,
            description: chargeNote,
            square_payment_id: chargeResult.paymentId,
            status: 'succeeded',
            retry_attempt: 0,
            billing_period_start: todayLocal,
            billing_period_end: plan.next_billing_date,
            succeeded_at: now
          });
          // Clean billing state - reset retry, clear first_failure_at, set new billing period
          await db.update('subaccount_plans', {
            status: 'active',
            suspended_at: null,
            first_failure_at: null,
            retry_count: 0,
            last_charge_attempt_at: now,
            last_charge_status: 'succeeded',
            current_period_start: now,
            updated_at: now
          }, { subaccount_id: subaccountId });
        } else {
          // Charge failed - go to past_due (cron will retry on dunning schedule)
          newStatus = 'past_due';
          await db.update('subaccount_plans', {
            status: 'past_due',
            suspended_at: null,
            first_failure_at: now,
            retry_count: 1,
            last_charge_attempt_at: now,
            last_charge_status: 'failed',
            updated_at: now
          }, { subaccount_id: subaccountId });
        }
      } else {
        // Skip charge (or no card / exempt) - just restore status
        newStatus = plan.first_failure_at ? 'past_due' : 'active';
        await db.update('subaccount_plans', {
          status: newStatus,
          suspended_at: null,
          updated_at: now
        }, { subaccount_id: subaccountId });
      }

      await logAudit({
        req, ...actor,
        action: 'agency.subaccount.unsuspend',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        metadata: {
          previous_status: 'suspended',
          new_status: newStatus,
          plan_tier: plan.plan_tier,
          mode: mode || 'simple',
          charge_attempted: chargeAttempted,
          charge_succeeded: chargeSucceeded,
          charge_error: chargeResult && !chargeResult.success ? chargeResult.error : null
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Subaccount restored. Status: ' + newStatus + '.',
        new_status: newStatus,
        charge_attempted: chargeAttempted,
        charge_succeeded: chargeSucceeded
      });
    }

  } catch (e) {
    console.error('suspend error:', e);
    return sendError(res, 500, 'Operation failed', e.message);
  }
}

exports.handler = wrap(handler);
