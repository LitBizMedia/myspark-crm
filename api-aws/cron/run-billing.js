// api/cron/run-billing.js (Lambda version - Secrets Manager)
//
// Daily cron - charges all subaccounts due today via Square card-on-file.
//
// AWS schedule: EventBridge → cron(0 9 * * ? *)
//
// CREDENTIALS: CRON_SECRET (HTTP testing path) from Secrets Manager.
//
// CHANGED 2026-05-07: TZ-aware. The "due today" filter now compares
// next_billing_date against today in EACH subaccount's own timezone, so a
// sub due May 8 in Eastern doesn't get charged at midnight UTC May 8 (which
// is 8pm Eastern May 7, a day early). Same fix for retry-tomorrow, trial
// reminders, and cancelled-account deactivation.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { chargeCardOnFile, calculateCharge, makeIdempotencyKey } = require('./lib/agency-billing');
const { sendEmail } = require('./lib/billing-emails');
const { logAudit } = require('./lib/audit');
const { deleteSubaccount } = require('./lib/subaccount-lifecycle');
const { wrap } = require('./lib/lambda-adapter');
const {
  todayInTz, nextBillingDateInTz, dateInTzPlusDays, getSubTimezone, DEFAULT_TZ
} = require('./lib/timezone');

const MAX_RETRIES        = 3;
const SUSPEND_AFTER_DAYS = 7;

const CRON_ACTOR = { actorType: 'cron', actorId: 'cron-run-billing', actorUsername: 'cron', actorRole: 'system' };

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

async function updatePlan(subaccountId, updates) {
  updates.updated_at = new Date().toISOString();
  await db.update('subaccount_plans', updates, { subaccount_id: subaccountId });
}

async function getAdminEmail(subaccountId) {
  try {
    const sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'admin_email, name' }
    );
    return sub ? sub.admin_email : null;
  } catch (e) {
    console.error('getAdminEmail error for ' + subaccountId + ':', e.message);
    return null;
  }
}

async function processBilling(req, sub, summary) {
  // Look up THIS subaccount's TZ for date math.
  const tz = await getSubTimezone(sub.subaccount_id, db);
  const todayLocal = todayInTz(tz);
  const tomorrowLocal = dateInTzPlusDays(1, tz);

  // BEFORE charging, apply any pending plan change that's effective today or earlier.
  // This is the only place pending downgrades take effect; the cron sees them, applies
  // them to the live plan fields, clears the pending_* fields, then charges at the new rate.
  if (sub.pending_change_effective_at) {
    const raw = sub.pending_change_effective_at;
    const effDate = raw instanceof Date
      ? raw.toISOString().slice(0, 10)
      : String(raw).slice(0, 10);
    if (effDate <= todayLocal) {
      const beforeSnapshot = {
        plan_tier: sub.plan_tier,
        billing_period: sub.billing_period,
        hipaa_addon: !!sub.hipaa_addon
      };
      const afterSnapshot = {
        plan_tier: sub.pending_plan_tier || sub.plan_tier,
        billing_period: sub.pending_billing_period || sub.billing_period,
        hipaa_addon: sub.pending_hipaa_addon !== null && sub.pending_hipaa_addon !== undefined
          ? !!sub.pending_hipaa_addon
          : !!sub.hipaa_addon
      };
      await updatePlan(sub.subaccount_id, {
        plan_tier: afterSnapshot.plan_tier,
        billing_period: afterSnapshot.billing_period,
        hipaa_addon: afterSnapshot.hipaa_addon,
        pending_plan_tier: null,
        pending_billing_period: null,
        pending_hipaa_addon: null,
        pending_change_effective_at: null,
        pending_change_note: null
      });
      await logAudit({
        req, ...CRON_ACTOR,
        action: 'agency.subaccount.plan_downgrade_applied',
        targetType: 'subaccount',
        targetId: sub.subaccount_id,
        targetSubaccountId: sub.subaccount_id,
        metadata: {
          effective_at: effDate,
          before: beforeSnapshot,
          after: afterSnapshot,
          original_note: sub.pending_change_note || null
        }
      });
      // Mutate the in-memory sub so the charge below uses the new rate.
      sub.plan_tier = afterSnapshot.plan_tier;
      sub.billing_period = afterSnapshot.billing_period;
      sub.hipaa_addon = afterSnapshot.hipaa_addon;
      console.log('run-billing: pending change applied for ' + sub.subaccount_id
        + ' -> ' + afterSnapshot.plan_tier + ' (' + afterSnapshot.billing_period + ')');
    }
  }

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

  const nextDate = nextBillingDateInTz(sub.billing_period, tz);

  await db.insertOne('subaccount_invoices', {
    subaccount_id: sub.subaccount_id,
    amount_cents: amountCents,
    description: chargeNote,
    square_payment_id: result.success ? result.paymentId : null,
    status: result.success ? 'succeeded' : 'failed',
    failure_reason: result.success ? null : result.error,
    retry_attempt: retryNum,
    billing_period_start: todayLocal,
    billing_period_end: nextDate,
    succeeded_at: result.success ? new Date().toISOString() : null,
    failed_at: result.success ? null : new Date().toISOString()
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
        planTier: sub.plan_tier, billingPeriod: sub.billing_period,
        subaccountId: sub.subaccount_id
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
      await db.update('subaccounts', { active: false }, { id: sub.subaccount_id });
      if (adminEmail) await sendEmail(adminEmail, 'suspended', { subName, dollars, subaccountId: sub.subaccount_id });

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
        next_billing_date: tomorrowLocal
      });
      if (adminEmail) await sendEmail(adminEmail, 'past_due', { subName, dollars, retryCount: newRetryCount, subaccountId: sub.subaccount_id });

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
        next_billing_date: tomorrowLocal
      });
      if (adminEmail) {
        await sendEmail(adminEmail, 'payment_failed', {
          subName, dollars,
          retryCount: newRetryCount,
          maxRetries: MAX_RETRIES,
          nextRetryDate: tomorrowLocal,
          subaccountId: sub.subaccount_id
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
          next_retry_date: tomorrowLocal
        }
      });
    }
  }
}

async function processCancelledAccounts(req, summary) {
  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString();

  let cancelled = [];
  try {
    cancelled = await db.findMany('subaccount_plans', { status: 'cancelled' });
  } catch (e) {
    return;
  }

  for (const sub of cancelled) {
    try {
      // Deletion cutoff: 30 days since cancel timestamp. canceled_at is a
      // TIMESTAMPTZ so UTC comparison is correct here (both UTC).
      if (sub.canceled_at && sub.canceled_at <= cutoffDate) {
        console.log('run-billing: auto-deleting cancelled subaccount ' + sub.subaccount_id);
        const delResult = await deleteSubaccount(sub.subaccount_id, {
          req: req,
          actor: CRON_ACTOR,
          actionName: 'system.subaccount.auto_delete',
          reason: 'cancelled_30_days'
        });
        if (delResult.success) {
          summary.deleted = (summary.deleted || 0) + 1;
          if (delResult.partial) {
            summary.partial_deletes = (summary.partial_deletes || 0) + 1;
          }
        } else {
          console.error('run-billing: auto-delete failed for ' + sub.subaccount_id + ':', delResult.error);
          summary.errors.push({ subaccount_id: sub.subaccount_id, error: 'Auto-delete failed: ' + delResult.error });
        }
        continue;
      }
      // Period-ended deactivation: compare next_billing_date against today
      // in THIS sub's timezone, not UTC.
      const subTz = await getSubTimezone(sub.subaccount_id, db);
      const todayLocal = todayInTz(subTz);
      if (sub.next_billing_date && sub.next_billing_date <= todayLocal) {
        await db.update('subaccounts', { active: false }, { id: sub.subaccount_id });
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
  // Trial reminder window: 2-3 days from now. Ranges expressed against
  // each subaccount's TZ via SQL JOIN to the blob timezone.
  try {
    const dueSubsResult = await db.query(
      `SELECT sp.* FROM subaccount_plans sp
       LEFT JOIN subaccount_data sd ON sd.subaccount_id = sp.subaccount_id
       WHERE sp.status = 'trialing'
         AND sp.exempt_from_billing = false
         AND sp.trial_ends_at::date >= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '2 days')
         AND sp.trial_ends_at::date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '3 days')`,
      [DEFAULT_TZ]
    );
    const dueSubs = dueSubsResult.rows;

    for (const sub of dueSubs) {
      try {
        const subRow = await db.findOne('subaccounts',
          { id: sub.subaccount_id },
          { select: 'name, admin_email' }
        );
        if (!subRow || !subRow.admin_email) continue;

        const subName    = subRow.name || sub.subaccount_id;
        const adminEmail = subRow.admin_email;
        const amountCents = calculateCharge(
          sub.plan_tier,
          sub.billing_period,
          sub.hipaa_addon,
          sub.discount_percent || 0
        );
        const dollars     = (amountCents / 100).toFixed(2);
        const trialEndDate = sub.trial_ends_at ? sub.trial_ends_at.toISOString().slice(0, 10) : 'soon';

        await sendEmail(adminEmail, 'trial_ending_soon', { subName, trialEndDate, dollars, subaccountId: sub.subaccount_id });
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

async function runBilling(req) {
  const summary = { processed: 0, succeeded: 0, failed: 0, suspended: 0, errors: [] };

  try {
    // Due-today filter: compare next_billing_date against today in EACH
    // subaccount's own timezone (read from the blob). Falls back to default
    // TZ for any sub without a timezone setting.
    const dueResult = await db.query(
      `SELECT sp.* FROM subaccount_plans sp
       LEFT JOIN subaccount_data sd ON sd.subaccount_id = sp.subaccount_id
       WHERE sp.next_billing_date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)
         AND sp.status IN ('trialing', 'active', 'past_due')
         AND sp.exempt_from_billing = false`,
      [DEFAULT_TZ]
    );
    const dueSubaccounts = dueResult.rows;
    summary.processed = dueSubaccounts.length;
    console.log('run-billing: ' + dueSubaccounts.length + ' subaccounts due');

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
    return summary;

  } catch (e) {
    console.error('run-billing fatal error:', e.message);
    await logAudit({
      req, ...CRON_ACTOR,
      action: 'system.billing.cron_fatal',
      outcome: 'failure',
      errorMessage: e.message,
      metadata: { summary }
    });
    throw e;
  }
}

async function httpHandler(req, res) {
  const authHeader = req.headers.authorization || '';
  const cronSecret = await getCronSecret();
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const summary = await runBilling(req);
    return res.status(200).json(summary);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

const httpWrapped = wrap(httpHandler);

exports.handler = async function (event, context) {
  const isScheduledEvent = event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler');

  if (isScheduledEvent) {
    // Scheduled mode: re-throw on errors so Lambda Errors metric fires and
    // CloudWatch alarms trigger. summary.failed (declined cards) is normal
    // and does NOT throw; only summary.errors[] (processing exceptions) does.
    let summary;
    try {
      const synthReq = { headers: {} };
      summary = await runBilling(synthReq);
    } catch (e) {
      console.error('run-billing eventbridge fatal error:', e.stack || e.message);
      throw e;
    }
    if (summary && summary.errors && summary.errors.length > 0) {
      console.error('run-billing had ' + summary.errors.length + ' errors. Summary:', JSON.stringify(summary, null, 2));
      const err = new Error('run-billing had ' + summary.errors.length + ' processing errors');
      err.summary = summary;
      throw err;
    }
    return summary;
  }

  return httpWrapped(event, context);
};
