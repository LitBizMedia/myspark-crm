// api/subaccount/audit-log.js (Lambda version)
//
// GET /api/subaccount/audit-log
//
// Read audit log entries for the calling subaccount only.
// Server enforces the scope: a subaccount admin can never read another
// subaccount's logs even by manipulating query parameters. Admin role required.
//
// MIGRATED: Supabase REST → lib/db.js for audit_log queries.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Admin role required to view audit logs
  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset) || 0, 0);

  // CRITICAL: scope is from session, NEVER from query params.
  const scopedSubaccountId = auth.subaccount_id;

  // Build dynamic WHERE clause
  const whereParts = ['target_subaccount_id = $1'];
  const params = [scopedSubaccountId];
  let p = 2;

  if (q.actor) {
    whereParts.push('actor_id = $' + p++);
    params.push(q.actor);
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
  if (q.target_id) {
    whereParts.push('target_id = $' + p++);
    params.push(q.target_id);
  }

  const whereSql = 'WHERE ' + whereParts.join(' AND ');

  try {
    // Run count and rows queries in parallel for speed
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
    console.error('subaccount audit-log read error:', e);
    return res.status(500).json({ error: 'Failed to load audit log: ' + e.message });
  }
}

exports.handler = wrap(handler);
