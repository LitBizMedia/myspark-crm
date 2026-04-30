// api/agency/audit-log.js (Lambda version)
//
// GET /api/agency/audit-log
//
// Read audit log entries (agency-side, can see all subaccounts).
// Returns entries in reverse chronological order.
//
// MIGRATED: Supabase REST → lib/db.js for audit_log queries.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset) || 0, 0);

  // Build dynamic WHERE clause
  const whereParts = [];
  const params = [];
  let p = 1;

  if (q.subaccount) {
    whereParts.push('target_subaccount_id = $' + p++);
    params.push(q.subaccount);
  }
  if (q.actor) {
    whereParts.push('actor_id = $' + p++);
    params.push(q.actor);
  }
  if (q.actorType) {
    whereParts.push('actor_type = $' + p++);
    params.push(q.actorType);
  }
  if (q.outcome) {
    whereParts.push('outcome = $' + p++);
    params.push(q.outcome);
  }
  if (q.action) {
    whereParts.push('action ILIKE $' + p++);
    params.push('%' + q.action + '%');
  }
  if (q.from) {
    whereParts.push('created_at >= $' + p++);
    params.push(q.from);
  }
  if (q.to) {
    whereParts.push('created_at <= $' + p++);
    params.push(q.to);
  }

  const whereSql = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

  try {
    const [rowsResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS n FROM audit_log ${whereSql}`,
        params
      )
    ]);

    return res.status(200).json({
      entries: rowsResult.rows,
      total: countResult.rows[0].n,
      limit: limit,
      offset: offset
    });

  } catch (e) {
    console.error('audit-log read error:', e);
    return res.status(500).json({ error: 'Failed to load audit log: ' + e.message });
  }
}

exports.handler = wrap(handler);
