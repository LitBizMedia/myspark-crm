// api/billing/cancel.js
// Cancels a subaccount subscription at end of the current billing period.
// Account stays active and accessible until next_billing_date.
// Cron handles actual deactivation when that date arrives.
// Auto-delete runs 30 days after canceled_at.

const { sendError } = require('../../lib/square');
const { sendEmail } = require('../../lib/billing-emails');

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
      return sendError(res, 400, 'Exempt accounts cannot be cancelled this way. Remove exemption first.');
    }
    if (plan.status === 'cancelled') {
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
      return sendError(res, 500, 'Failed to cancel plan: ' + await updateRes.text());
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
      // Non-fatal: cancellation already succeeded, just log the email failure
      console.error('cancel.js: email send failed:', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription cancelled. Access continues until ' + (plan.next_billing_date || 'end of current period') + '.',
      access_until: plan.next_billing_date || null
    });

  } catch (e) {
    console.error('cancel error:', e);
    return sendError(res, 500, 'Cancellation failed', e.message);
  }
};
