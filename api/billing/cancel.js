// api/billing/cancel.js
// Cancels a subaccount subscription at end of the current billing period.
// Account stays active and accessible until next_billing_date.
// Cron handles actual deactivation when that date arrives.
// Auto-delete runs 30 days after canceled_at.

const { sendError } = require('../../lib/square');
const { sendEmail } = require('../../lib/billing-emails');
const { logAudit } = require('../../lib/audit');
const { requireAgencyAuth } = require('../../lib/require-subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { subaccountId } = req.body || {};
  if (!subaccountId) return sendError(res, 400, 'subaccountId required');

  // Require valid agency session
  const auth = await requireAgencyAuth(req, res);
  if (!auth) return; // 401 already sent
  const actor = {
    actorType:     'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role
  };

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

    // Mark as cancelled. Account stays active until next_billing_date.
    const updateRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({
          status: 'cancelled',
          canceled_at: now,
          updated_at: now
        })
      }
    );
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      await logAudit({
        req, ...actor,
        action: 'agency.plan.cancel',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'failure',
        errorMessage: 'DB update failed: ' + errText
      });
      return sendError(res, 500, 'Failed to cancel plan: ' + errText);
    }

    // Send cancellation confirmation email
    try {
      const subRes = await fetch(
        SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId + '&select=name,admin_email',
        { headers: sbHeaders() }
      );
      if (subRes.ok) {
        const subRows = await subRes.json();
        if (subRows && subRows.length && subRows[0].admin_email) {
          await sendEmail(subRows[0].admin_email, 'cancellation_confirmed', {
            subName: subRows[0].name || subaccountId,
            accessUntil: plan.next_billing_date || null
          });
        }
      }
    } catch (emailErr) {
      console.error('cancel.js: email send failed:', emailErr.message);
    }

    // Audit log: success
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
};
