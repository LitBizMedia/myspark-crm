// api/cron/run-billing.js
// Daily cron: fires at 9 AM UTC via Vercel.
// Finds subaccounts with next_billing_date <= today, charges their saved card,
// logs invoices, and handles retries / suspension.
//
// REAL MONEY: Be careful modifying this file. Test with Patrick's own card first.

const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('../../lib/agency-billing');
const { sendEmail } = require('../../lib/billing-emails');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_RETRIES        = 3;
const SUSPEND_AFTER_DAYS = 7;

// Common actor for cron-initiated actions
const CRON_ACTOR = { actorType: 'cron', actorId: 'cron-run-billing', actorUsername: 'cron', actorRole: 'system' };

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== 'Bearer ' + CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  const summary = { processed: 0, succeeded: 0, failed: 0, suspended: 0, errors: [] };

  try {
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
        await processBilling(req, sub, summary);
      } catch (e) {
        console.error('run-billing: error processing ' + sub.subaccount_id, e.message);
        summary.errors.push({ subaccount_id: sub.subaccount_id, error: e.message });
        await logAudit({
          req, ...CRON_ACTOR,
          action: 'system.billing.processing_error',
          targetType: 'subaccount',
          targetId: sub.subaccount_id,
          targetSubaccountId: sub.subaccount_id,
          outcome: 'failure',
          errorMessage: e.message
        });
      }
    }

    await processCancelledAccounts(req, summary);
    await sendTrialReminders(req);

    console.log('run-billing complete:', JSON.stringify(summary));
    return res.status(200).json(summary);

  } catch (e) {
    console.error('run-billing fatal error:', e.message);
    await logAudit({
      req, ...CRON_ACTOR,
      action: 'system.billing.cron_fatal',
      outcome: 'failure',
      errorMessage: e.message,
      metadata: { summary }
    });
    return res.status(500).json({ error: e.message, summary });
  }
};

async function processBilling(req, sub, summary) {
  const amountCents = calculateCharge(
    sub.plan_tier,
    sub.billing_period,
    sub.hipaa_addon,
    sub.discount_percent || 0
  );
  const dollars = (amountCents / 100).toFixed(2);
  const chargeNote = 'MySpark+ ' + sub.plan_tier + ' (' + sub.billing_period + ')';
  const retryNum = sub.retry_count || 0;
  const idempotencyKey = makeIdempotencyKey('chg', sub.subaccount_id, sub.next_billing_date, 'r' + retryNum);

  const result = await chargeCardOnFile(
    sub.square_customer_id,
    sub.square_card_id,
    amountCents,
    chargeNote,
    idempotencyKey
  );

  const nextDate = calcNextBillingDate(sub.billing_period);

  await fetch(SUPABASE_URL + '/rest/v1/subaccount_invoices', {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      subaccount_id: sub.subaccount_id,
      amount_cents: amountCents,
      description: chargeNote,
      square_payment_id: result.success ? result.paymentId : null,
      status: result.success ? 'succeeded' : 'failed',
      failure_reason: result.success ? null : result.error,
      retry_attempt: retryNum,
      billing_period_start: new Date().toISOString().split('T')[0],
      billing_period_end: nextDate,
      succeeded_at: result.success ? new Date().toISOString() : null,
      failed_at: result.success ? null : new Date().toISOString()
    })
  });

  const adminEmail = await getAdminEmail(sub.subaccount_id);
  const subName = sub.subaccount_name || sub.subaccount_id;

  if (result.success) {
    summary.succeeded++;
    await updatePlan(sub.subaccount_id, {
      status: 'active',
      next_billing_date: nextDate,
      current_period_start: new Date().toISOString(),
      last_charge_attempt_at: new Date().toISOString(),
      last_charge_status: 'succeeded',
      retry_count: 0
    });
    if (adminEmail) {
      await sendEmail(adminEmail, 'receipt', {
        subName, dollars, nextBillingDate: nextDate,
        planTier: sub.plan_tier, billingPeriod: sub.billing_period
      });
    }
    await logAudit({
      req, ...CRON_ACTOR,
      action: 'system.billing.charge_success',
      targetType: 'subaccount',
      targetId: sub.subaccount_id,
      targetSubaccountId: sub.subaccount_id,
      metadata: {
        amount_cents: amountCents,
        square_payment_id: result.paymentId,
        plan_tier: sub.plan_tier,
        billing_period: sub.billing_period,
        next_billing_date: nextDate,
        retry_attempt: retryNum,
        was_trial_conversion: sub.status === 'trialing'
      }
    });

  } else {
    summary.failed++;
    const newRetryCount = retryNum + 1;
    const lastAttempt = sub.last_charge_attempt_at ? new Date(sub.last_charge_attempt_at).getTime() : null;
    const daysSinceLastAttempt = lastAttempt ? (Date.now() - lastAttempt) / 86400000 : 0;
    const shouldSuspend = newRetryCount >= MAX_RETRIES && daysSinceLastAttempt >= SUSPEND_AFTER_DAYS;

    if (shouldSuspend) {
      summary.suspended++;
      await updatePlan(sub.subaccount_id, {
        status: 'suspended',
        suspended_at: new Date().toISOString(),
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed_suspended',
        retry_count: newRetryCount
      });
      await fetch(SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + sub.subaccount_id, {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ active: false })
      });
      if (adminEmail) await sendEmail(adminEmail, 'suspended', { subName, dollars });

      await logAudit({
        req, ...CRON_ACTOR,
        action: 'system.billing.suspend',
        targetType: 'subaccount',
        targetId: sub.subaccount_id,
        targetSubaccountId: sub.subaccount_id,
        metadata: {
          reason: 'failed_payments',
          retry_count: newRetryCount,
          attempted_amount_cents: amountCents,
          last_error: result.error
        }
      });

    } else if (newRetryCount >= MAX_RETRIES) {
      await updatePlan(sub.subaccount_id, {
        status: 'past_due',
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed',
        retry_count: newRetryCount,
        next_billing_date: tomorrowDate()
      });
      if (adminEmail) await sendEmail(adminEmail, 'past_due', { subName, dollars, retryCount: newRetryCount });

      await logAudit({
        req, ...CRON_ACTOR,
        action: 'system.billing.past_due',
        targetType: 'subaccount',
        targetId: sub.subaccount_id,
        targetSubaccountId: sub.subaccount_id,
        outcome: 'failure',
        errorMessage: result.error,
        metadata: {
          retry_count: newRetryCount,
          attempted_amount_cents: amountCents
        }
      });

    } else {
      await updatePlan(sub.subaccount_id, {
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_status: 'failed',
        retry_count: newRetryCount,
        next_billing_date: tomorrowDate()
      });
      if (adminEmail) {
        await sendEmail(adminEmail, 'payment_failed', {
          subName, dollars,
          retryCount: newRetryCount,
          maxRetries: MAX_RETRIES,
          nextRetryDate: tomorrowDate()
        });
      }
      await logAudit({
        req, ...CRON_ACTOR,
        action: 'system.billing.charge_failed',
        targetType: 'subaccount',
        targetId: sub.subaccount_id,
        targetSubaccountId: sub.subaccount_id,
        outcome: 'failure',
        errorMessage: result.error,
        metadata: {
          retry_count: newRetryCount,
          attempted_amount_cents: amountCents,
          next_retry_date: tomorrowDate()
        }
      });
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

async function getAdminEmail(subaccountId) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + subaccountId + '&select=admin_email,name',
      { headers: sbHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows || !rows.length) return null;
    return rows[0].admin_email || null;
  } catch (e) {
    console.error('getAdminEmail error for ' + subaccountId + ':', e.message);
    return null;
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

async function processCancelledAccounts(req, summary) {
  const today = new Date().toISOString().split('T')[0];
  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString();

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
        summary.deleted = (summary.deleted || 0) + 1;
        await logAudit({
          req, ...CRON_ACTOR,
          action: 'system.subaccount.auto_delete',
          targetType: 'subaccount',
          targetId: sub.subaccount_id,
          targetSubaccountId: sub.subaccount_id,
          metadata: {
            reason: 'cancelled_30_days',
            canceled_at: sub.canceled_at,
            plan_tier: sub.plan_tier
          }
        });
        continue;
      }
      // Deactivate: access period has ended
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
        await logAudit({
          req, ...CRON_ACTOR,
          action: 'system.subaccount.deactivate',
          targetType: 'subaccount',
          targetId: sub.subaccount_id,
          targetSubaccountId: sub.subaccount_id,
          metadata: {
            reason: 'cancelled_period_ended',
            next_billing_date: sub.next_billing_date
          }
        });
      }
    } catch (e) {
      console.error('processCancelledAccounts error for ' + sub.subaccount_id, e.message);
    }
  }
}

async function sendTrialReminders(req) {
  try {
    const threeDaysFromNow = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    const twoDaysFromNow   = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
    const url = SUPABASE_URL + '/rest/v1/subaccount_plans'
      + '?status=eq.trialing'
      + '&trial_ends_at=gte.' + twoDaysFromNow
      + '&trial_ends_at=lte.' + threeDaysFromNow
      + '&exempt_from_billing=eq.false'
      + '&select=*';

    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) return;
    const dueSubs = await r.json();

    for (const sub of (dueSubs || [])) {
      try {
        const rSub = await fetch(
          SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + sub.subaccount_id + '&select=name,admin_email',
          { headers: sbHeaders() }
        );
        if (!rSub.ok) continue;
        const subRows = await rSub.json();
        if (!subRows || !subRows.length || !subRows[0].admin_email) continue;

        const subName    = subRows[0].name || sub.subaccount_id;
        const adminEmail = subRows[0].admin_email;
        const amountCents = calculateCharge(
          sub.plan_tier,
          sub.billing_period,
          sub.hipaa_addon,
          sub.discount_percent || 0
        );
        const dollars     = (amountCents / 100).toFixed(2);
        const trialEndDate = sub.trial_ends_at ? sub.trial_ends_at.split('T')[0] : 'soon';

        await sendEmail(adminEmail, 'trial_ending_soon', { subName, trialEndDate, dollars });
        console.log('trial-reminder sent to ' + adminEmail + ' for ' + sub.subaccount_id);

        await logAudit({
          req, ...CRON_ACTOR,
          action: 'system.billing.trial_reminder_sent',
          targetType: 'subaccount',
          targetId: sub.subaccount_id,
          targetSubaccountId: sub.subaccount_id,
          metadata: {
            trial_end_date: trialEndDate,
            upcoming_charge_cents: amountCents
          }
        });

      } catch (e) {
        console.error('sendTrialReminders: error for ' + sub.subaccount_id + ':', e.message);
      }
    }
  } catch (e) {
    console.error('sendTrialReminders error:', e.message);
  }
}
