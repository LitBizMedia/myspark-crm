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
const { processSub, computeCharge } = require('./lib/sub-charge');
const { sendEmail } = require('./lib/mailgun');
const recurringEmail = require('./lib/recurring-billing-email');
const { shouldSend } = require('./lib/notifications');
const { sendPatientSms } = require('./lib/patient-sms');
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
  // Cast a bounded 31-day net in SQL (the max a subaccount could configure),
  // then enforce each subaccount's CONFIGURED "days before" precisely in the
  // loop via the notification gate's timing_minutes_before. SQL can't know the
  // per-type catalog default (it lives in JS), so the gate does the real
  // filtering. The window is a self-healing catch-up: trial_ends_at from
  // tomorrow through the configured horizon, guarded by trial_reminder_sent_at
  // so a missed cron day still sends on the next run, exactly once.
  const r = await db.query(
    `SELECT s.*, sd.data AS blob_data
     FROM subscriptions s
     LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
     WHERE s.status = 'trialing'
       AND s.trial_reminder_sent_at IS NULL
       AND s.trial_ends_at IS NOT NULL
       AND s.trial_ends_at > ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)
       AND s.trial_ends_at <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '31 days')`,
    [DEFAULT_TZ]
  );

  summary.reminders_found = r.rows.length;

  for (const row of r.rows) {
    const blob = row.blob_data || {};
    const tz = (blob.settings && blob.settings.timezone) || DEFAULT_TZ;

    // Per-subaccount timing gate. Fetched up front so we honor the configured
    // "days before" and skip rows outside this subaccount's window before doing
    // any work. Default 4320 min (3 days) matches prior hardcoded behavior.
    const trialGate = await shouldSend(row.subaccount_id, 'recurring_billing_trial_ending', db);
    if (!trialGate.ok) {
      summary.reminders_skipped = (summary.reminders_skipped || 0) + 1;
      summary.reminder_results = summary.reminder_results || [];
      summary.reminder_results.push({ sub_id: row.id, skipped: true, reason: trialGate.reason || 'disabled' });
      continue;
    }
    const windowDays = Math.max(1, Math.round((trialGate.timing_minutes_before || 4320) / 1440));
    // Is the trial end within this subaccount's configured horizon (in its TZ)?
    const horizonOk = await db.query(
      `SELECT ($1::date) <= ((NOW() AT TIME ZONE $2)::date + ($3 || ' days')::interval) AS within`,
      [row.trial_ends_at, tz, String(windowDays)]
    );
    if (!horizonOk.rows[0] || !horizonOk.rows[0].within) {
      // Not yet inside this subaccount's window; a future cron run will catch it.
      summary.reminders_skipped = (summary.reminders_skipped || 0) + 1;
      continue;
    }

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

    // (Gate already fetched + checked at loop top as trialGate.)
    // Email and SMS fire independently per channel. The dedup
    // (trial_reminder_sent_at) is set if EITHER channel succeeds, so an
    // SMS-only trial reminder still marks itself sent and never re-fires.
    let anySent = false;
    let lastErr = null;

    // Email channel
    if (trialGate.email_enabled) {
      try {
        const result = await sendEmail(subaccountSlug, {
          to: contact.email,
          subject: subject,
          html: html,
          fromName: bizName,
          templateType: 'subscription-trial-reminder',
          contactId: contact.id
        });
        if (result && result.ok) anySent = true;
        else lastErr = (result && result.error) || 'email returned not-ok';
      } catch (e) {
        lastErr = e.message;
        console.error('Trial reminder email error:', e.message);
      }
    }

    // SMS channel (independent). Date-only body; the email carries the charge
    // amount and breakdown. No plan name (could carry meaning). Dispatcher owns
    // phone, consent, footer.
    if (trialGate.sms_enabled && contact.id) {
      try {
        const smsBody = bizName + ': your trial ends ' + trialEndStr
          + ', and your subscription begins after that. Questions? Give us a call.';
        const smsRes = await sendPatientSms({
          subaccountId: row.subaccount_id,
          subaccountSlug: subaccountSlug,
          typeKey: 'recurring_billing_trial_ending',
          contactId: contact.id,
          body: smsBody,
          source: 'trial-reminder'
        });
        if (smsRes && smsRes.sent) anySent = true;
      } catch (e) {
        console.warn('Trial reminder SMS error:', e.message);
      }
    }

    if (anySent) {
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
      summary.reminder_results.push({ sub_id: row.id, error: lastErr || 'no channel sent' });
    }
  }
}

// Upcoming-charge scan: find active subs whose next_due_date falls within each
// subaccount's CONFIGURED reminder window (timing_minutes_before, default 3
// days) in the sub's own timezone, that haven't been notified this cycle. Send
// patient an upcoming charge reminder. Idempotent: relies on subscription_events
// containing 'upcoming_charge_sent' within MAX_WINDOW_DAYS for de-dupe.
async function runUpcomingChargeScan(summary, dryRun) {
  // Bounded 31-day SQL net; each subaccount's CONFIGURED "days before" is then
  // enforced precisely in the loop via the gate's timing_minutes_before (SQL
  // can't see the JS catalog default). The dedup window is widened to 31 days
  // too: it suppresses re-sends within a billing cycle regardless of the
  // configured reminder window, so a clinic setting 7 days can't get both a
  // 7-day and a 3-day reminder for the same charge. next_due_date advancing
  // after each charge naturally resets eligibility for the next cycle.
  const MAX_WINDOW_DAYS = 31;
  const r = await db.query(
    `SELECT s.*, sd.data AS blob_data
     FROM subscriptions s
     LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
     WHERE s.status = 'active'
       AND s.contact_id IS NOT NULL
       AND s.next_due_date > ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date)
       AND s.next_due_date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date + INTERVAL '${MAX_WINDOW_DAYS} days')
       AND NOT EXISTS (
         SELECT 1 FROM subscription_events e
         WHERE e.subscription_id = s.id
           AND e.event_type = 'upcoming_charge_sent'
           AND e.created_at > NOW() - INTERVAL '${MAX_WINDOW_DAYS} days'
       )`,
    [DEFAULT_TZ]
  );
  summary.upcoming_found = r.rows.length;

  for (const row of r.rows) {
    try {
      const upBlob = row.blob_data || {};
      const upTz = (upBlob.settings && upBlob.settings.timezone) || DEFAULT_TZ;

      // Per-subaccount configured window. Default 4320 min (3 days) matches the
      // prior hardcoded REMIND_DAYS so untouched subaccounts are unchanged.
      const upGate = await shouldSend(row.subaccount_id, 'recurring_billing_upcoming_charge', db);
      if (!upGate.ok) {
        summary.upcoming_skipped = (summary.upcoming_skipped || 0) + 1;
        continue;
      }
      const upWindowDays = Math.max(1, Math.round((upGate.timing_minutes_before || 4320) / 1440));
      const upHorizon = await db.query(
        `SELECT ($1::date) <= ((NOW() AT TIME ZONE $2)::date + ($3 || ' days')::interval) AS within`,
        [row.next_due_date, upTz, String(upWindowDays)]
      );
      if (!upHorizon.rows[0] || !upHorizon.rows[0].within) {
        summary.upcoming_skipped = (summary.upcoming_skipped || 0) + 1;
        continue;
      }

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

      // Compute discounted total via computeCharge so the email and the
      // event log both reflect what the customer will actually be charged.
      const upcomingBlob = row.blob_data || {};
      const upcomingTz = (upcomingBlob.settings && upcomingBlob.settings.timezone) || DEFAULT_TZ;
      const upcomingBreakdown = computeCharge(row, upcomingBlob.paySettings || {}, upcomingTz);
      const result = await recurringEmail.sendRecurringBillingEmail('upcoming_charge', Object.assign({}, ctx, {
        planName: row.plan_name_snapshot || 'your subscription',
        amount: upcomingBreakdown.total,
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
              amount: upcomingBreakdown.total,
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
         WHERE s.status IN ('active', 'trialing', 'past_due') AND s.id = $1`
      : `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE (
                 -- normal due charge
                 (s.status IN ('active', 'trialing')
                   AND s.next_due_date <= ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date))
                 OR
                 -- past_due dunning retry on days 2, 3, 5 since first_failure_at
                 (s.status = 'past_due'
                   AND s.first_failure_at IS NOT NULL
                   AND ((NOW() AT TIME ZONE COALESCE(sd.data->'settings'->>'timezone', $1))::date
                        - s.first_failure_at::date) IN (1, 2, 4))
               )`;
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
