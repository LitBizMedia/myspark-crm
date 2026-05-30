// api/billing/cancel.js (Lambda version)
//
// POST /api/billing/cancel
//
// Cancels a subaccount subscription at end of the current billing period.
// Account stays active until next_billing_date. Cron handles deactivation.
//
// MIGRATED: Supabase REST → lib/db.js for plan, subaccount queries.

const db = require('./lib/db');
const { sendError } = require('./lib/square');
const { sendEmail } = require('./lib/billing-emails');
const { logAudit } = require('./lib/audit');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId } = req.body || {};
  if (!subaccountId) return sendError(res, 400, 'subaccountId required');

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
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

    if (plan.exempt_from_billing) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.cancel',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'Cannot cancel exempt account'
      });
      return sendError(res, 400, 'Exempt accounts cannot be cancelled this way. Remove exemption first.');
    }
    if (plan.status === 'cancelled') {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.cancel',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'Account is already cancelled'
      });
      return sendError(res, 400, 'Account is already cancelled.');
    }

    const now = new Date().toISOString();

    // Mark as cancelled
    try {
      await db.update('subaccount_plans',
        {
          status: 'cancelled',
          canceled_at: now,
          updated_at: now
        },
        { subaccount_id: subaccountId }
      );
    } catch (e) {
      await logAudit({
        req, ...actor,
        action: 'agency.plan.cancel',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'failure',
        errorMessage: 'DB update failed: ' + e.message
      });
      return sendError(res, 500, 'Failed to cancel plan: ' + e.message);
    }

    // Send cancellation email
    try {
      const sub = await db.findOne('subaccounts',
        { id: subaccountId },
        { select: 'name, admin_email' }
      );
      if (sub && sub.admin_email) {
        await sendEmail(sub.admin_email, 'cancellation_confirmed', {
          subName: sub.name || subaccountId,
          accessUntil: plan.next_billing_date || null,
          subaccountId: subaccountId
        });
      }
    } catch (emailErr) {
      console.error('cancel.js: email send failed:', emailErr.message);
    }

    await logAudit({
      req, ...actor,
      action: 'agency.plan.cancel',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: {
        plan_tier: plan.plan_tier,
        billing_period: plan.billing_period,
        access_until: plan.next_billing_date,
        previous_status: plan.status
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Subscription cancelled. Access continues until ' + (plan.next_billing_date || 'end of current period') + '.',
      access_until: plan.next_billing_date || null
    });

  } catch (e) {
    console.error('cancel error:', e);
    await logAudit({
      req, ...actor,
      action: 'agency.plan.cancel',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: e.message
    });
    return sendError(res, 500, 'Cancellation failed', e.message);
  }
}

exports.handler = wrap(handler);
