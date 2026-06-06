// api/cron/index-size-watch.js (Lambda version)
//
// Daily cron - watches table row counts (n_live_tup) and alerts via SNS
// (myspark-alerts) when any table first crosses the row threshold. The
// alert email carries the full index-audit prompt in the body so the
// trigger and the instructions arrive together.
//
// AWS schedule: EventBridge -> cron(0 13 * * ? *)  (8am ET / 9am EST, daily)
//
// CREDENTIALS: CRON_SECRET (HTTP testing path) from Secrets Manager.
//
// Idempotency: index_audit_alerts table, PK on table_name. Each table
// alerts once on its crossing via ON CONFLICT DO NOTHING. Never nags again.
//
// Threshold: 10,000 live rows. audit_log is EXCLUDED by name: it grows
// forever from normal logging, every query against it filters by time and
// hits an index, so a high row count there is expected and needs no audit.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || 'arn:aws:sns:us-east-2:993939946677:myspark-alerts';
const ROW_THRESHOLD = 10000;
const EXCLUDED_TABLES = ['audit_log'];

const snsClient = new SNSClient({});

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

async function publishAlert(subject, message) {
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: subject.slice(0, 100),
      Message: message
    }));
  } catch (e) {
    console.error('SNS publish failed:', e.message);
    throw e;
  }
}

const AUDIT_PROMPT = [
  "Thalos, it's index audit time. A table crossed the row threshold or we have real clinic traffic now.",
  "Re-run the full index audit against RDS via myspark-audit-db. I want four things: missing-index",
  "candidates (seq_scan over 100, sorted by seq_tup_read, with n_live_tup and table_size so we can",
  "separate real signal from small-table noise), unused indexes (idx_scan = 0, excluding primary keys,",
  "flagging is_unique and backs_constraint so we don't drop anything load-bearing), the stats window",
  "(stats_reset and postmaster_start), and the unindexed-foreign-key check across the CASCADE-heavy",
  "schema. Categorize as ADD NOW, DROP NOW, or DEFER, and tell me which tables are now big enough that",
  "the planner actually flips to index scans. Don't hand me any CREATE or DROP until recon confirms",
  "current index definitions.",
  "",
  "Two carried-forward notes from the June 5 2026 audit. One: the contacts pagination indexes from",
  "MySpark-Contacts-Pagination-Spec.md are already built (idx_contacts_email, idx_contacts_phone,",
  "idx_contacts_search_trgm). Do not re-add them; the handoff notes were stale. Two: contacts showed",
  "heavy sequential scans those indexes do not explain. That mystery is unsolved. When this audit",
  "fires, start with pg_stat_statements on contacts to catch the actual offending query before adding",
  "any index. Do not guess from table-level stats."
].join('\n');

async function findCrossings() {
  const r = await db.query(`
    SELECT relname AS table_name, n_live_tup AS row_count
    FROM pg_stat_user_tables
    WHERE n_live_tup >= $1
      AND relname <> ALL($2::text[])
    ORDER BY n_live_tup DESC
  `, [ROW_THRESHOLD, EXCLUDED_TABLES]);
  return r.rows;
}

async function handle() {
  const over = await findCrossings();
  const newlyAlerted = [];

  for (const row of over) {
    const ins = await db.query(`
      INSERT INTO index_audit_alerts (table_name, row_count, threshold)
      VALUES ($1, $2, $3)
      ON CONFLICT (table_name) DO NOTHING
    `, [row.table_name, row.row_count, ROW_THRESHOLD]);

    if (ins.rowCount > 0) {
      newlyAlerted.push({ table_name: row.table_name, row_count: Number(row.row_count) });
    }
  }

  if (newlyAlerted.length > 0) {
    const lines = newlyAlerted
      .map(t => '  - ' + t.table_name + ': ' + t.row_count.toLocaleString() + ' rows')
      .join('\n');
    const subject = 'MySpark index audit due: ' + newlyAlerted.length + ' table(s) crossed ' + ROW_THRESHOLD.toLocaleString() + ' rows';
    const message =
      'These tables just crossed the ' + ROW_THRESHOLD.toLocaleString() + '-row threshold:\n\n' +
      lines + '\n\n' +
      'At this size the query planner starts flipping to index scans, so the index audit now has\n' +
      'real signal. Paste the prompt below to Thalos to run it.\n\n' +
      '--- AUDIT PROMPT (copy everything below) ---\n\n' +
      AUDIT_PROMPT + '\n';
    await publishAlert(subject, message);
  }

  return {
    threshold: ROW_THRESHOLD,
    tables_over_threshold: over.map(r => ({ table_name: r.table_name, row_count: Number(r.row_count) })),
    newly_alerted: newlyAlerted
  };
}

exports.handler = async (event) => {
  const isScheduled = !!(event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler'));

  if (!isScheduled) {
    const provided = event && (event.cron_secret || (event.headers && event.headers['x-cron-secret']));
    const expected = await getCronSecret();
    if (!provided || provided !== expected) {
      return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    }
  }

  try {
    const result = await handle();
    if (isScheduled) return result;
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('index-size-watch failed:', e.message);
    if (isScheduled) throw e;
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
