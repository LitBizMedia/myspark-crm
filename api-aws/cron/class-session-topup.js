// api/cron/class-session-topup.js
//
// Daily cron - extends the rolling session horizon for never-ending classes.
//
// AWS schedule: EventBridge -> cron(0 8 * * ? *)  (08:00 UTC = 4am ET during EDT)
//
// THE BUG THIS FIXES: services-upsert generates sessions out to HORIZON_DAYS
// (90) on save, but nothing advances that horizon as days pass. Without this
// cron a class generates 90 days once, then silently runs out. This tops up
// every active never-ending class to the rolling horizon, every day.
//
// CREDENTIALS: CRON_SECRET (HTTP testing path) from Secrets Manager.
//
// SAFETY INVARIANTS:
//   - Idempotent: inserts only session dates that do not already exist for the
//     series. Re-running inserts nothing.
//   - Never touches override sessions (is_override = true) and never updates
//     existing rows, so a session with an enrolled/paid roster is untouchable.
//   - Never deletes.
//   - Finite series (end_type after/on_date) are skipped; they stop naturally.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { wrap } = require('./lib/lambda-adapter');
const {
  parseRule,
  generateSessionsFromRule,
  bulkInsertSessions,
  horizonDateStr,
  todayStr
} = require('./lib/class-sessions');

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

// Tops up a single class service. Returns { added, skipped_existing }.
async function topUpClass(service) {
  const rule = parseRule(service.recurrence_rule);
  if (!rule) return { added: 0, reason: 'no_rule' };

  // Only never-ending series roll forward. Finite series stop on their own.
  if ((rule.end_type || 'never') !== 'never') return { added: 0, reason: 'finite' };
  if (rule.repeats === 'once') return { added: 0, reason: 'once' };

  // The services table has no duration column; per-session duration lives on
  // class_sessions. Read the series' current duration (and re-confirm other
  // fields) from the most recent existing session so new sessions match the
  // series exactly. Fall back to 60 only if no session exists yet.
  const ref = await db.query(
    `SELECT duration, capacity, location, price, instructor_id, title
     FROM class_sessions
     WHERE series_id = $1 AND subaccount_id = $2
     ORDER BY date DESC LIMIT 1`,
    [service.id, service.subaccount_id]
  );
  const refRow = ref.rows[0] || null;

  // Shape the service object the way generateSessionsFromRule expects.
  const svcForEngine = {
    id: service.id,
    name: refRow && refRow.title != null ? refRow.title : service.name,
    instructor_id: refRow && refRow.instructor_id != null ? refRow.instructor_id : service.instructor_id,
    capacity: refRow && refRow.capacity != null ? refRow.capacity : service.capacity,
    location: refRow && refRow.location != null ? refRow.location : service.location,
    price: refRow && refRow.price != null ? refRow.price : service.price,
    duration_default: refRow && refRow.duration != null ? refRow.duration : 60
  };

  // Generate the full candidate set from rule start to the rolling horizon.
  // generateSessionsFromRule caps never-ending series at the horizon internally.
  const candidates = generateSessionsFromRule(svcForEngine, rule);
  if (!candidates.length) return { added: 0, reason: 'no_candidates' };

  // Pull existing session dates for this series (series_id = service.id).
  // Date-based dedup: one session per matching day per series.
  const existing = await db.query(
    `SELECT date FROM class_sessions
     WHERE series_id = $1 AND subaccount_id = $2`,
    [service.id, service.subaccount_id]
  );
  const existingDates = new Set(
    existing.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0,10) : String(r.date).slice(0,10)))
  );

  // Insert only candidates whose date is not already present.
  const missing = candidates.filter(c => !existingDates.has(c.date));
  if (missing.length) {
    await bulkInsertSessions(db, missing, service.subaccount_id);
  }

  // Advance the high-water mark on the service.
  await db.query(
    `UPDATE services SET last_generated_through = $1, updated_at = NOW()
     WHERE id = $2 AND subaccount_id = $3`,
    [horizonDateStr(), service.id, service.subaccount_id]
  );

  return { added: missing.length, skipped_existing: candidates.length - missing.length };
}

async function runTopUp() {
  // Active class services carrying a recurrence rule. Finite series are loaded
  // too but topUpClass skips them; cheap and keeps the query simple.
  const result = await db.query(
    `SELECT id, subaccount_id, name, instructor_id, capacity, location,
            price, recurrence_rule
     FROM services
     WHERE type = 'class'
       AND active != false
       AND recurrence_rule IS NOT NULL`
  );

  let classesProcessed = 0;
  let classesToppedUp = 0;
  let sessionsAdded = 0;
  let failed = 0;
  const details = [];

  for (const service of result.rows) {
    classesProcessed++;
    try {
      const r = await topUpClass(service);
      if (r.added > 0) {
        classesToppedUp++;
        sessionsAdded += r.added;
      }
      details.push({ id: service.id, name: service.name, added: r.added || 0, reason: r.reason });
    } catch (e) {
      failed++;
      console.error('class topup failed for service ' + service.id + ' (' + service.name + '): ' + e.message);
      details.push({ id: service.id, name: service.name, error: e.message });
    }
  }

  return {
    success: true,
    today: todayStr(),
    horizon: horizonDateStr(),
    classesProcessed,
    classesToppedUp,
    sessionsAdded,
    failed,
    details
  };
}

async function httpHandler(req, res) {
  const auth = req.headers.authorization || '';
  const cronSecret = await getCronSecret();
  if (cronSecret && auth !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runTopUp();
    return res.status(200).json(result);
  } catch (e) {
    console.error('class-session-topup error:', e);
    return res.status(500).json({ error: e.message });
  }
}

const httpWrapped = wrap(httpHandler);

exports.handler = async function (event, context) {
  const isScheduledEvent = event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler');

  if (isScheduledEvent) {
    // Scheduled mode: re-throw on errors so the Lambda Errors metric fires.
    let summary;
    try {
      summary = await runTopUp();
    } catch (e) {
      console.error('class-session-topup eventbridge fatal error:', e.stack || e.message);
      throw e;
    }
    if (summary && summary.failed > 0) {
      console.error('class-session-topup had ' + summary.failed + ' failures. Summary:', JSON.stringify(summary, null, 2));
      const err = new Error('class-session-topup had ' + summary.failed + ' failed classes');
      err.summary = summary;
      throw err;
    }
    return summary;
  }

  return httpWrapped(event, context);
};
