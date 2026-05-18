// api/cron/email-domain-grace-warnings.js (Lambda version)
//
// Daily cron job that sends grace period warning emails to subaccount admins.
//
// Grace period is 14 days from row creation. Warning milestones:
//   day 7  remaining: gentle nudge
//   day 4  remaining: more urgent
//   day 1  remaining: final warning
//   day 0  (expired): notification that branded sending is recommended
//
// Per Phase 2 decision #1 (soft notification, not hard block):
//   - We send warning emails at milestones
//   - We do NOT set grace_period_blocked=true
//   - We do NOT prevent emails from sending
//   - The UI banner persists indefinitely after day 0
//
// Idempotency: warning_emails_sent jsonb array tracks which milestones have
// been sent ([7, 4, 1, 0]) so we never send duplicates.
//
// Scope: only checks rows where sending_mode='shared' (branded subaccounts
// have already done the right thing and don't need nagging).
//
// Schedule: EventBridge cron, daily at 14:00 UTC (9am Central, 10am Eastern)

const db = require('./lib/db');
const { sendEmail } = require('./lib/mailgun');

const MILESTONES = [
  { days: 7, key: 7,  subject: 'Verify your email domain in MySpark+ (7 days remaining)' },
  { days: 4, key: 4,  subject: 'Verify your email domain in MySpark+ (4 days remaining)' },
  { days: 1, key: 1,  subject: 'Final reminder: verify your email domain in MySpark+' },
  { days: 0, key: 0,  subject: 'Your MySpark+ email domain grace period has ended' }
];

const APP_URL = process.env.APP_URL || 'https://mysparkplus.app';

function daysRemaining(graceEndsAt) {
  if (!graceEndsAt) return null;
  const end = new Date(graceEndsAt).getTime();
  const now = Date.now();
  const ms = end - now;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function pickMilestone(daysLeft, alreadySent) {
  // Find the highest-priority milestone we should send today but haven't yet.
  // We use "at or below" semantics so if cron skips a day, we catch up.
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    if (daysLeft <= m.days && alreadySent.indexOf(m.key) === -1) {
      return m;
    }
  }
  return null;
}

function buildEmail(subaccountName, slug, daysLeft, milestone) {
  const dashboardLink = APP_URL + '/' + slug + '#settings/email';
  const urgency = milestone.key === 0
    ? 'Your 14-day grace period has now ended.'
    : 'You have <strong>' + Math.max(daysLeft, 0) + ' day' + (daysLeft === 1 ? '' : 's') + '</strong> remaining in your grace period.';

  const callToAction = milestone.key === 0
    ? 'You can continue sending emails through our shared infrastructure, but we strongly recommend verifying your own domain for the best deliverability and brand consistency with your patients.'
    : 'To send emails from your own domain (better deliverability, better brand trust with patients), please verify your domain in MySpark+ before your grace period expires.';

  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 12px">Email Domain Verification</h2>'
    + '<p style="margin:0 0 16px;color:#5a4d7a;font-size:15px;line-height:1.5">Hi ' + subaccountName + ',</p>'
    + '<p style="margin:0 0 16px;color:#5a4d7a;font-size:15px;line-height:1.5">' + urgency + '</p>'
    + '<p style="margin:0 0 20px;color:#5a4d7a;font-size:15px;line-height:1.5">' + callToAction + '</p>'
    + '<a href="' + dashboardLink + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:20px">Open Settings &raquo;</a>'
    + '<p style="font-size:13px;color:#5a4d7a;margin:20px 0 8px;line-height:1.5">If you have questions about setting up your email domain, reply to this email and we will help.</p>'
    + '<p style="font-size:12px;color:#9b8ec4;margin:0">MySpark+ by LitBiz Media</p>'
    + '</div>';
}

async function processOneRow(row) {
  const daysLeft = daysRemaining(row.grace_period_ends_at);
  if (daysLeft === null) return { skipped: 'no_grace_date' };
  if (daysLeft > 7) return { skipped: 'too_early_(' + daysLeft + ' days)' };

  const alreadySent = Array.isArray(row.warning_emails_sent) ? row.warning_emails_sent : [];
  const milestone = pickMilestone(daysLeft, alreadySent);
  if (!milestone) return { skipped: 'all_milestones_sent' };

  // Get admin email for this subaccount
  const subaccountResult = await db.query(
    'SELECT id, name, slug, admin_email FROM subaccounts WHERE id = $1',
    [row.subaccount_id]
  );
  if (!subaccountResult.rows.length) return { skipped: 'subaccount_not_found' };

  const sub = subaccountResult.rows[0];
  if (!sub.admin_email) return { skipped: 'no_admin_email' };

  const html = buildEmail(sub.name || 'MySpark+ user', sub.slug, daysLeft, milestone);

  let sendResult;
  try {
    sendResult = await sendEmail(null, {
      scope: 'agency',
      to: sub.admin_email,
      subject: milestone.subject,
      html: html,
      templateType: 'email_domain_grace_warning',
      subaccountId: row.subaccount_id
    });
  } catch (e) {
    console.error('grace-warnings: send threw for sub ' + row.subaccount_id + ':', e.message);
    return { error: e.message, milestone: milestone.key };
  }

  if (!sendResult || !sendResult.ok) {
    console.error('grace-warnings: send failed for sub ' + row.subaccount_id + ':', sendResult && sendResult.error);
    return { error: sendResult && sendResult.error, milestone: milestone.key };
  }

  // Record that this milestone was sent (append to jsonb array)
  const newSent = alreadySent.concat([milestone.key]);
  await db.query(
    'UPDATE subaccount_email_domains SET warning_emails_sent = $1::jsonb WHERE id = $2',
    [JSON.stringify(newSent), row.id]
  );

  return { sent: true, milestone: milestone.key, daysLeft };
}

exports.handler = async (event, context) => {
  const isScheduled = event && event['detail-type'] === 'Scheduled Event';
  console.log('grace-warnings: starting, scheduled=' + isScheduled);

  const results = {
    checked: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    details: []
  };

  try {
    // Get all shared-mode rows with active grace period (not yet expired by more than 30 days)
    const r = await db.query(`
      SELECT * FROM subaccount_email_domains
      WHERE sending_mode = 'shared'
        AND grace_period_ends_at IS NOT NULL
        AND grace_period_ends_at > NOW() - INTERVAL '30 days'
      ORDER BY grace_period_ends_at ASC
    `);

    results.checked = r.rows.length;

    for (const row of r.rows) {
      const outcome = await processOneRow(row);
      if (outcome.sent) results.sent++;
      else if (outcome.error) results.errors++;
      else results.skipped++;
      results.details.push({ subaccount_id: row.subaccount_id, ...outcome });
    }

    console.log('grace-warnings: ' + JSON.stringify(results));

    if (isScheduled && results.errors > 0) {
      // Throw so CloudWatch Lambda Errors metric fires for monitoring
      throw new Error('grace-warnings: ' + results.errors + ' send error(s)');
    }

    return results;

  } catch (e) {
    console.error('grace-warnings: fatal error:', e.message);
    if (isScheduled) throw e;
    return { error: e.message, partial: results };
  }
};
