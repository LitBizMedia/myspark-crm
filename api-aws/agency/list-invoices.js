// api/agency/list-invoices.js (Lambda version)
//
// GET /api/agency/list-invoices
//
// Returns recent billing transactions joined with subaccount names.
// Reverse chronological order. Filters and pagination supported.
//
// MIGRATED: Supabase REST + PostgREST embedding → lib/db.js with explicit JOIN.

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

  // Build dynamic WHERE
  const whereParts = [];
  const params = [];
  let p = 1;

  if (q.subaccount) {
    whereParts.push('si.subaccount_id = $' + p++);
    params.push(q.subaccount);
  }
  if (q.status) {
    whereParts.push('si.status = $' + p++);
    params.push(q.status);
  }
  if (q.from) {
    whereParts.push('si.created_at >= $' + p++);
    params.push(q.from);
  }
  if (q.to) {
    whereParts.push('si.created_at <= $' + p++);
    params.push(q.to);
  }

  const whereSql = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

  try {
    // Manual JOIN replaces PostgREST's embedded select=*,subaccounts(id,name,slug)
    const [rowsResult, countResult] = await Promise.all([
      db.query(
        `SELECT 
           si.*,
           json_build_object(
             'id', s.id,
             'name', s.name,
             'slug', s.slug
           ) AS subaccounts
         FROM subaccount_invoices si
         LEFT JOIN subaccounts s ON s.id = si.subaccount_id
         ${whereSql}
         ORDER BY si.created_at DESC
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS n FROM subaccount_invoices si ${whereSql}`,
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
    console.error('list-invoices error:', e);
    return res.status(500).json({ error: 'Failed to load invoices: ' + e.message });
  }
}

exports.handler = wrap(handler);
