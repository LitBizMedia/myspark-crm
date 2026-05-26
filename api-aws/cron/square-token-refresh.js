// api/cron/square-token-refresh.js (Lambda)
//
// Triggered daily by EventBridge.
// Refreshes Square OAuth access tokens that expire within 7 days.
//
// Per Square's OAuth Best Practices, applications should refresh tokens
// every 7 days or less so failed refreshes have 23+ days to be detected
// and resolved before the access token actually expires.
//
// On any refresh failure: publish to SNS (myspark-alerts) and update the
// last_refresh_error column. On scheduled runs, throw at the end if any
// failures occurred so CloudWatch Lambda Errors metric fires.
//
// Manual invoke payload:
//   { "slug": "litbiz" }          force-refresh a specific slug
//   { "dry_run": true }           scan and log only, no API calls or DB writes

const db = require('./lib/db');
const { refreshAccessToken } = require('./lib/square');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || 'arn:aws:sns:us-east-2:993939946677:myspark-alerts';
const REFRESH_WINDOW_DAYS = 7;

const snsClient = new SNSClient({});

async function publishAlert(subject, message) {
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: subject.slice(0, 100),
      Message: message
    }));
  } catch (e) {
    console.error('SNS publish failed:', e.message);
  }
}

exports.handler = async (event) => {
  const isScheduled = !!(event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler'));

  let slugFilter = null;
  let dryRun = false;
  if (event && typeof event === 'object') {
    slugFilter = event.slug || null;
    dryRun = !!event.dry_run;
  }

  const summary = {
    started_at: new Date().toISOString(),
    is_scheduled: isScheduled,
    dry_run: dryRun,
    slug_filter: slugFilter,
    found: 0,
    refreshed: 0,
    failed: 0,
    skipped: 0,
    results: []
  };

  let rows;
  try {
    if (slugFilter) {
      const subaccountId = 'sub-' + slugFilter;
      const r = await db.query(
        `SELECT subaccount_id, expires_at FROM square_credentials WHERE subaccount_id = $1`,
        [subaccountId]
      );
      rows = r.rows;
    } else {
      const r = await db.query(
        `SELECT subaccount_id, expires_at
         FROM square_credentials
         WHERE refresh_token IS NOT NULL
           AND (expires_at IS NULL OR expires_at < NOW() + INTERVAL '${REFRESH_WINDOW_DAYS} days')`
      );
      rows = r.rows;
    }
  } catch (e) {
    console.error('square-token-refresh: query failed:', e.message);
    await publishAlert('Square token refresh cron query failed', 'Error: ' + e.message);
    throw new Error('query failed: ' + e.message);
  }

  summary.found = rows.length;

  for (const row of rows) {
    const slug = String(row.subaccount_id).replace(/^sub-/, '');

    if (dryRun) {
      summary.skipped++;
      summary.results.push({ slug, dry_run: true, current_expires_at: row.expires_at });
      continue;
    }

    let result;
    try {
      result = await refreshAccessToken(slug);
    } catch (e) {
      result = { ok: false, error: 'unexpected: ' + e.message };
    }

    const attemptedAt = new Date().toISOString();
    if (result.ok) {
      summary.refreshed++;
      summary.results.push({ slug, success: true, new_expires_at: result.expires_at, rotated_refresh: result.rotated_refresh });
      try {
        await db.query(
          `UPDATE square_credentials
           SET last_refresh_attempted_at = $1, last_refresh_error = NULL
           WHERE subaccount_id = $2`,
          [attemptedAt, row.subaccount_id]
        );
      } catch (_) { /* non-fatal */ }
    } else {
      summary.failed++;
      summary.results.push({ slug, success: false, error: result.error });
      try {
        await db.query(
          `UPDATE square_credentials
           SET last_refresh_attempted_at = $1, last_refresh_error = $2
           WHERE subaccount_id = $3`,
          [attemptedAt, String(result.error).slice(0, 1000), row.subaccount_id]
        );
      } catch (_) { /* non-fatal */ }
      await publishAlert(
        'Square token refresh failed for ' + slug,
        'Subaccount: ' + slug + '\n' +
        'Error: ' + result.error + '\n' +
        'Current expires_at: ' + row.expires_at + '\n' +
        'Action required: verify Square connection in MySpark+ admin and reconnect if needed.'
      );
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('square-token-refresh summary:', JSON.stringify(summary));

  if (isScheduled && summary.failed > 0) {
    throw new Error(`square-token-refresh had ${summary.failed} failure(s)`);
  }

  return summary;
};
