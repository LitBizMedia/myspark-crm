// api/cron/subscriptions-charge.js (Lambda)
//
// Triggered daily by EventBridge, OR manually invoked for testing.
// All charge logic lives in lib/sub-charge.js (shared with subscriptions-create
// for immediate-charge-on-save).
//
// Manual invoke payload:
//   { "sub_id": "sub-..." }      only process this one sub (skips date filter)
//   { "dry_run": true }          compute and log but don't charge or write
//   { "skip_reminders": true }   skip the trial reminder scan
//
// Per run:
//   1. CHARGE PASS - find subs with status in (active, trialing) and
//      next_due_date <= today_in_sub_tz; charge each via processSub.
//   2. REMINDER PASS - find subs with status='trialing' whose trial_ends_at
//      is within 3 days and reminder hasn't been sent; send email reminder.
//
// Idempotency: source_id = sub-{id}-{next_due_date} for charges. Reminders
// guarded by trial_reminder_sent_at column being non-null.

const db = require('./lib/db');
const { isLineTaxable } = require('./lib/tax');
const contactsLib = require('./lib/contacts');
const { processSub } = require('./lib/sub-charge');
const { sendEmail } = require('./lib/mailgun');
const recurringEmail = require('./lib/recurring-billing-email');
const { shouldSend } = require('./lib/notifications');
const { DEFAULT_TZ } = require('./lib/timezone');

function fmt$(n) {
  return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
}

function fmtDate(dateStr, tz) {
  if (!dateStr) return '';
  const s = String(dateStr).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: tz || DEFAULT_TZ
  });
}

// Compute the charge total for a trialing sub, mirroring computeCharge math.
// Used for the reminder email so the customer knows their first charge amount.
function estimateChargeAmount(sub, paySettings) {
  const tax = paySettings && paySettings.tax;
  const taxEnabled = !!(tax && tax.enabled && parseFloat(tax.rate) > 0);
  const taxRate = taxEnabled ? parseFloat(tax.rate) : 0;
  const items = sub.items || [];
  let afterDiscount = 0;
  let taxableAmount = 0;
  for (const it of items) {
    const lineSubtotal = (parseFloat(it.price) || 0) * (it.qty || 1);
    let lineDiscount = 0;
    if (it.discountType === 'flat') {
      lineDiscount = Math.min(lineSubtotal, parseFloat(it.discountValue) || 0);
    } else if (it.discountType === 'pct') {
      lineDiscount = lineSubtotal * ((parseFloat(it.discountValue) || 0) / 100);
    }
    const lineAfter = lineSubtotal - lineDiscount;
    afterDiscount += lineAfter;
    // Match computeCharge: subscription items go through 'subscription' section.
    if (isLineTaxable(paySettings, 'subscription', it)) taxableAmount += lineAfter;
  }
  const tax_ = Math.round(taxableAmount * taxRate) / 100;
  return Math.round((afterDiscount + tax_) * 100) / 100;
}

async function runReminderScan(summary, dryRun) {
  // Find trialing subs whose trial_ends_at is between today (exclusive) and
  // today+3 (inclusive), in each sub's own TZ, that have NOT been notified.
  const r = await db.query(
    `SELECT s.*, sd.data AS blob_data
     FROM subscriptions s
     LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
     WHERE s.status = 'trialing'
       AND s.trial_reminder_sent_at IS NULL
       AND s.trial_ends_at IS NOT NULL
       AND s.trial_ends_at > ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)
       AND s.trial_ends_at <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '3 days')`,
    [DEFAULT_TZ]
  );

  summary.reminders_found = r.rows.length;

  for (const row of r.rows) {
    const blob = row.blob_data || {};
    const tz = (blob.settings && blob.settings.timezone) || DEFAULT_TZ;
    const contact = await contactsLib.getContactById(row.subaccount_id, row.contact_id);

    if (!contact || !contact.email) {
      summary.reminders_skipped = (summary.reminders_skipped || 0) + 1;
      continue;
    }

    const bizName = (blob.settings && blob.settings.businessName) || 'MySpark+';
    const subaccountSlug = String(row.subaccount_id || '').replace(/^sub-/, '');
    const trialEndStr = fmtDate(row.trial_ends_at, tz);
    const chargeAmount = estimateChargeAmount(row, blob.paySettings || {});
    const planName = row.plan_name_snapshot || 'your subscription';

    const subject = 'Your trial ends ' + trialEndStr;
    const html =
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
      + '<h2 style="color:#6b21ea;margin:0 0 8px">Your trial ends soon</h2>'
      + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">Hi ' + (contact.name || 'there') + ', this is a heads-up that your free trial for ' + planName + ' wraps up on ' + trialEndStr + '.</p>'
      + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">'
      + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:140px">Plan</td><td style="padding:8px 0;font-weight:600">' + planName + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:140px">Trial ends</td><td style="padding:8px 0;font-weight:600">' + trialEndStr + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:140px">First charge</td><td style="padding:8px 0;font-weight:600">' + fmt$(chargeAmount) + '</td></tr>'
      + '</table>'
      + '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">Your card on file will be charged automatically. To cancel before then, contact us.</p>'
      + '<p style="color:#5a4d7a;font-size:14px;margin:24px 0 0">Thanks,<br>' + bizName + '</p>'
      + '</div>';

    if (dryRun) {
      summary.reminders_sent = (summary.reminders_sent || 0) + 1;
      summary.reminder_results = summary.reminder_results || [];
      summary.reminder_results.push({ sub_id: row.id, dry_run: true, would_send_to: contact.email });
      continue;
    }

    // Gate: subaccount admin can disable this in Notifications tab
    const reminderGate = await shouldSend(row.subaccount_id, 'recurring_billing_trial_ending', db);
    if (!reminderGate.ok) {
      summary.reminders_skipped = (summary.reminders_skipped || 0) + 1;
      summary.reminder_results = summary.reminder_results || [];
      summary.reminder_results.push({ sub_id: row.id, skipped: true, reason: reminderGate.reason || 'disabled' });
      continue;
    }

    try {
      const result = await sendEmail(subaccountSlug, {
        to: contact.email,
        subject: subject,
        html: html,
        fromName: bizName,
        templateType: 'subscription-trial-reminder',
        contactId: contact.id
      });

      if (result && result.ok) {
        await db.query(
          `UPDATE subscriptions SET trial_reminder_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await db.query(
          `INSERT INTO subscription_events (
            id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
          ) VALUES ($1, $2, $3, 'trial_reminder_sent', NULL, 'system', $4::jsonb, NOW())`,
          [
            `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            row.id, row.subaccount_id,
            JSON.stringify({
              trial_ends_at: row.trial_ends_at,
              estimated_charge: chargeAmount,
              email: contact.email
            })
          ]
        );
        summary.reminders_sent = (summary.reminders_sent || 0) + 1;
      } else {
        summary.reminders_failed = (summary.reminders_failed || 0) + 1;
        summary.reminder_results = summary.reminder_results || [];
        summary.reminder_results.push({ sub_id: row.id, error: (result && result.error) || 'send returned not-ok' });
      }
    } catch (e) {
      console.error('Trial reminder send error:', e.message);
      summary.reminders_failed = (summary.reminders_failed || 0) + 1;
      summary.reminder_results = summary.reminder_results || [];
      summary.reminder_results.push({ sub_id: row.id, error: e.message });
    }
  }
}

// Upcoming-charge scan: find active subs whose next_due_date falls within
// REMIND_DAYS of today (in the sub's own timezone) AND that haven't been
// notified in the last REMIND_DAYS-1 days. Send patient an upcoming charge
// reminder. Idempotent: relies on subscription_events containing
// 'upcoming_charge_sent' for de-dupe.
async function runUpcomingChargeScan(summary, dryRun) {
  const REMIND_DAYS = 3;
  const r = await db.query(
    `SELECT s.*, sd.data AS blob_data
     FROM subscriptions s
     LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
     WHERE s.status = 'active'
       AND s.contact_id IS NOT NULL
       AND s.next_due_date > ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)
       AND s.next_due_date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '${REMIND_DAYS} days')
       AND NOT EXISTS (
         SELECT 1 FROM subscription_events e
         WHERE e.subscription_id = s.id
           AND e.event_type = 'upcoming_charge_sent'
           AND e.created_at > NOW() - INTERVAL '${REMIND_DAYS} days'
       )`,
    [DEFAULT_TZ]
  );
  summary.upcoming_found = r.rows.length;

  for (const row of r.rows) {
    try {
      const ctx = await recurringEmail._loadContext(row.subaccount_id, row.contact_id);
      if (!ctx) {
        summary.upcoming_skipped = (summary.upcoming_skipped || 0) + 1;
        continue;
      }

      if (dryRun) {
        summary.upcoming_sent = (summary.upcoming_sent || 0) + 1;
        summary.upcoming_results = summary.upcoming_results || [];
        summary.upcoming_results.push({ sub_id: row.id, dry_run: true, would_send_to: ctx.recipientEmail });
        continue;
      }

      const result = await recurringEmail.sendRecurringBillingEmail('upcoming_charge', Object.assign({}, ctx, {
        planName: row.plan_name_snapshot || 'your subscription',
        amount: parseFloat(row.cycle_price) || 0,
        billingCycle: row.billing_cycle || '',
        nextDate: row.next_due_date
      }));

      if (result && result.ok && !result.skipped) {
        await db.query(
          `INSERT INTO subscription_events (
            id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
          ) VALUES ($1, $2, $3, 'upcoming_charge_sent', NULL, 'system', $4::jsonb, NOW())`,
          [
            `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            row.id, row.subaccount_id,
            JSON.stringify({
              next_due_date: row.next_due_date,
              amount: parseFloat(row.cycle_price) || 0,
              email: ctx.recipientEmail
            })
          ]
        );
        summary.upcoming_sent = (summary.upcoming_sent || 0) + 1;
      } else {
        summary.upcoming_skipped = (summary.upcoming_skipped || 0) + 1;
      }
    } catch (e) {
      console.error('Upcoming charge send error:', e.message);
      summary.upcoming_failed = (summary.upcoming_failed || 0) + 1;
    }
  }
}


exports.handler = async function (event) {
  const options = {};
  let subIdFilter = null;
  let skipReminders = false;
  // Scheduled invocations come from EventBridge with detail-type 'Scheduled Event'.
  // For those, we throw on internal failures so the Lambda Errors metric fires
  // and CloudWatch alarms can pick it up. Manual invocations get the normal
  // structured response even on failure (so CLI testing isn't broken).
  const isScheduled = !!(event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler'));

  if (event && typeof event === 'object') {
    if (event.body) {
      try {
        const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        subIdFilter = b.sub_id || null;
        options.dry_run = !!b.dry_run;
        skipReminders = !!b.skip_reminders;
      } catch (_) {}
    } else {
      subIdFilter = event.sub_id || null;
      options.dry_run = !!event.dry_run;
      skipReminders = !!event.skip_reminders;
    }
  }

  const summary = {
    started_at: new Date().toISOString(),
    dry_run: !!options.dry_run,
    sub_id_filter: subIdFilter,
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    reminders_found: 0,
    reminders_sent: 0,
    reminders_failed: 0,
    reminders_skipped: 0,
    results: []
  };

  try {
    // CHARGE PASS: status in (active, trialing) and next_due_date is today
    // or earlier in the sub's timezone. Trialing subs hit this when
    // trial_ends_at <= today (since we set next_due_date = trial_ends_at).
    const sql = subIdFilter
      ? `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status IN ('active', 'trialing') AND s.id = $1`
      : `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status IN ('active', 'trialing')
           AND s.next_due_date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)`;
    const params = subIdFilter ? [subIdFilter] : [DEFAULT_TZ];
    const r = await db.query(sql, params);
    summary.found = r.rows.length;

    for (const row of r.rows) {
      summary.processed++;
      const blob = { data: row.blob_data || {} };
      const sub = { ...row };
      delete sub.blob_data;
      const result = await processSub(sub, blob, options);
      if (result.success) summary.succeeded++;
      else if (result.skipped) summary.skipped++;
      else summary.failed++;
      summary.results.push(result);
    }

    // REMINDER PASS: only on full daily runs, not single-sub manual tests.
    if (!subIdFilter && !skipReminders) {
      try {
        await runReminderScan(summary, !!options.dry_run);
        await runUpcomingChargeScan(summary, !!options.dry_run);
      } catch (remErr) {
        console.error('Reminder scan error:', remErr.stack);
        summary.reminder_scan_error = remErr.message;
      }
    }

    summary.finished_at = new Date().toISOString();

    // Scheduled mode: throw on internal failures so Lambda Errors metric fires
    // and CloudWatch alarms trigger. Log full summary first so it's preserved.
    if (isScheduled && (summary.failed > 0 || summary.reminders_failed > 0)) {
      console.error('Scheduled run had failures. Summary:', JSON.stringify(summary, null, 2));
      const err = new Error('Scheduled run had failures: ' + summary.failed + ' charges, ' + summary.reminders_failed + ' reminders');
      err.summary = summary;
      throw err;
    }

    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    console.error('Cron error:', e.stack || e.message);
    if (isScheduled) {
      // Re-throw uncaught errors in scheduled mode for CloudWatch visibility.
      console.error('Summary at failure:', JSON.stringify(summary, null, 2));
      throw e;
    }
    summary.error = e.message;
    summary.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(summary, null, 2) };
  }
};
