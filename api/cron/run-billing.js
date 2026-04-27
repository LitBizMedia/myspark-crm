// api/cron/run-billing.js
// Daily cron: fires at 9 AM UTC via Vercel.
// Finds subaccounts with next_billing_date <= today, charges their saved card,
// logs invoices, and handles retries / suspension.
//
// REAL MONEY: Be careful modifying this file. Test with Patrick's own card first.

const { chargeCardOnFile, calculateCharge } = require('../../lib/agency-billing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_RETRIES = 3;        // Mark past_due after this many failed attempts
const SUSPEND_AFTER_DAYS = 7; // Suspend subaccount if last attempt was 7+ days ago

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  // Verify the request came from Vercel cron (or an authorized manual trigger)
  const authHeader = req.headers.authorization || '';
  if (authHeader !== 'Bearer ' + CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  const summary = { processed: 0, succeeded: 0, failed: 0, suspended: 0, errors: [] };

  try {
    // Find all non-exempt subaccounts whose billing date is today or past
    const url = SUPABASE_URL + '/rest/v1/subaccount_plans'
      + '?next_billing_date=lte.' + today
      + '&status=in.(trialing,active,past_due)'
      + '&exempt_from_billing=eq.false'
      + '&select=*';

    const fetchRes = await fetch(url, { headers: sbHeaders() });
    if (!fetchRes.ok) {
      throw new Error('Failed to fetch due subaccounts: ' + await fetchRes.text());
    }

    const dueSubaccounts = await fetchRes.json();
    summary.processed = dueSubaccounts.length;
    console.log('run-billing: ' + dueSubaccounts.length + ' subaccounts due on ' + today);

    for (const sub of dueSubaccounts) {
      try {
        await processBilling(sub, summary);
      } catch (e) {
        console.error('run-billing: error processing ' + sub.subaccount_id, e.message);
        summary.errors.push({ subaccount_id: sub.subaccount_id, error: e.message });
      }
    }

    // Process cancelled accounts: deactivate expired, auto-delete after 30 days
    await processCancelledAccounts(summary);

    console.log('run-billing complete:', JSON.stringify(summary));
    return res.status(200).json(summary);

  } catch (e) {
    console.error('run-billing fatal error:', e.message);
    return res.status(500).json({ error: e.message, summary });
  }
};

async function processBilling(sub, summary) {
  const amountCents = calculateCharge(sub.plan_tier, sub.billing_period, sub.hipaa_addon, sub.discount_percent || 0);

  // If subaccount is still in trial, transition to active first,
  // then charge for the first real billing period.
  if (sub.status === 'trialing') {
    await updatePlan(sub.subaccount_id, {
      status: 'active',
      current_period_start: new Date().toISOString(),
      retry_count: 0
    });
  }

  // Attempt charge
  const chargeNote = 'MySpark+ ' + sub.plan_tier + ' (' + sub.billing_period + ')';
  const result = await chargeCardOnFile(
    sub.square_customer_id,
    sub.square_card_id,
    amountCents,
    chargeNote
  );

  // Log every attempt to subaccount_invoices
  const invoicePayload = {
    subaccount_id: sub.subaccount_id,
    amount_cents: amountCents,
    description: chargeNote,
    square_payment_id: result.success ? result.paymentId : null,
    status: result.success ? 'succeeded' : 'failed',
    failure_reason: result.success ? null : result.error,
    retry_attempt: sub.retry_count || 0,
    billing_period_start: new Date().toISOString().split('T')[0],
    billing_period_end: calcNextBillingDate(sub.billing_period),
    succeeded_at: result.success ? new Date().toISOString() : null,
    failed_at: result.success ? null : new Date().toISOString()
  };

  await fetch(SUPABASE_URL + '/rest/v1/subaccount_invoices', {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(invoicePayload)
  });

  if (result.success) {
    summary.succeeded++;
    await updatePlan(sub.subaccount_id, {
      status: 'active',
      next_billing_date: calcNextBillingDate(sub.billing_period),
      current_period_start: new Date().toISOString(),
      last_charge_attempt_at: new Date().toISOString(),
      last_charge_status: 'succeeded',
      retry_count: 0
    });
    await sendBillingEmail(sub, 'receipt', { amount: amountCents });

  } else {
    summary.failed++;
    const newRetryCount = (sub.retry_count || 0) + 1;

    // Check if last attempt was more than SUSPEND_AFTER_DAYS ago
    const lastAttempt = sub.last_charge_attempt_at ? new Date(sub.last_charge_attempt_at).getTime() : null;
    const daysSinceLastAttempt = lastAttempt
      ? (Date.now() - lastAttempt) / 86400000
      : 0;

    const shouldSuspend = newRetryCount >= MAX_RETRIES && daysSinceLastAttempt >= SUSPEND_AFTER_DAYS;

    if (shouldSuspend) {
      // Suspend: mark plan suspended and deactivate subaccount
      summary.suspended++;
      await updatePlan(sub.subaccount_id, {
        status: 'suspended',
        suspended_at: new Date().toISOString(),
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed_suspended',
        retry_count: newRetryCount
      });
      // Deactivate the subaccount itself
      await fetch(SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + sub.subaccount_id, {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ active: false })
      });
      await sendBillingEmail(sub, 'suspended', { amount: amountCents });

    } else if (newRetryCount >= MAX_RETRIES) {
      // Max retries reached but not yet at suspend threshold: mark past_due
      await updatePlan(sub.subaccount_id, {
        status: 'past_due',
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed',
        retry_count: newRetryCount,
        next_billing_date: tomorrowDate()
      });
      await sendBillingEmail(sub, 'past_due', { amount: amountCents, retryCount: newRetryCount });

    } else {
      // Still have retries left: retry tomorrow
      await updatePlan(sub.subaccount_id, {
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed',
        retry_count: newRetryCount,
        next_billing_date: tomorrowDate()
      });
      await sendBillingEmail(sub, 'payment_failed', { amount: amountCents, retryCount: newRetryCount });
    }
  }
}

async function updatePlan(subaccountId, updates) {
  updates.updated_at = new Date().toISOString();
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
    {
      method: 'PATCH',
      headers: sbHeaders(),
      body: JSON.stringify(updates)
    }
  );
  if (!res.ok) {
    throw new Error('updatePlan failed for ' + subaccountId + ': ' + await res.text());
  }
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

function tomorrowDate() {
  return new Date(Date.now() + 86400000).toISOString().split('T')[0];
}

async function processCancelledAccounts(summary) {
  const today = new Date().toISOString().split('T')[0];
  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString();

  // Fetch all cancelled accounts
  const fetchRes = await fetch(
    SUPABASE_URL + '/rest/v1/subaccount_plans?status=eq.cancelled&select=*',
    { headers: sbHeaders() }
  );
  if (!fetchRes.ok) return;
  const cancelled = await fetchRes.json();

  for (const sub of (cancelled || [])) {
    try {
      // Auto-delete: 30 days after canceled_at
      if (sub.canceled_at && sub.canceled_at <= cutoffDate) {
        console.log('run-billing: auto-deleting cancelled subaccount ' + sub.subaccount_id);
        await fetch(
          SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + sub.subaccount_id,
          { method: 'DELETE', headers: sbHeaders() }
        );
        if (summary.deleted !== undefined) summary.deleted++;
        else summary.deleted = 1;
        continue;
      }
      // Deactivate: access period has ended (next_billing_date has passed)
      if (sub.next_billing_date && sub.next_billing_date <= today) {
        await fetch(
          SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + sub.subaccount_id,
          {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify({ active: false })
          }
        );
        console.log('run-billing: deactivated cancelled subaccount ' + sub.subaccount_id);
      }
    } catch (e) {
      console.error('processCancelledAccounts error for ' + sub.subaccount_id, e.message);
    }
  }
}

async function sendBillingEmail(sub, type, data) {
  // TODO (Session 4): replace console.log with Resend email calls using branded templates.
  // Types: receipt, payment_failed, past_due, suspended
  const cents = data.amount || 0;
  const dollars = (cents / 100).toFixed(2);
  console.log('billing-email [' + type + '] subaccount=' + sub.subaccount_id + ' amount=$' + dollars + ' retry=' + (data.retryCount || 0));
}
