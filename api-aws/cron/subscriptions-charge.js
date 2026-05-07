// api/cron/subscriptions-charge.js (Lambda)
//
// Triggered daily by EventBridge, OR manually invoked for testing.
// All charge logic lives in lib/sub-charge.js (shared with subscriptions-create
// for immediate-charge-on-save).
//
// Manual invoke payload:
//   { "sub_id": "sub-..." }   only process this one sub (skips date filter)
//   { "dry_run": true }       compute and log but don't charge or write
//
// Idempotency: source_id = sub-{id}-{next_due_date}. If the Lambda crashes
// mid-flow, the next run with the same key returns Square's original payment
// (no double-charge), allowing us to complete the DB writes.

const db = require('./lib/db');
const { processSub } = require('./lib/sub-charge');

exports.handler = async function (event) {
  const options = {};
  let subIdFilter = null;

  if (event && typeof event === 'object') {
    if (event.body) {
      try {
        const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        subIdFilter = b.sub_id || null;
        options.dry_run = !!b.dry_run;
      } catch (_) {}
    } else {
      subIdFilter = event.sub_id || null;
      options.dry_run = !!event.dry_run;
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
    results: []
  };

  try {
    const sql = subIdFilter
      ? `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status = 'active' AND s.id = $1`
      : `SELECT s.*, sd.data AS blob_data
         FROM subscriptions s
         LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.subaccount_id
         WHERE s.status = 'active' AND s.next_due_date <= CURRENT_DATE`;
    const params = subIdFilter ? [subIdFilter] : [];
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

    summary.finished_at = new Date().toISOString();
    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    console.error('Cron error:', e.stack);
    summary.error = e.message;
    summary.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(summary, null, 2) };
  }
};
