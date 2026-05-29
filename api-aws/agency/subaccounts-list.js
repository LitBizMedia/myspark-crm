// api/agency/subaccounts-list.js (Lambda version)
// GET /api/agency/subaccounts-list[?include_data=true]
// Returns all subaccounts, optionally with their bulk data for stats.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const includeData = (req.query && req.query.include_data === 'true');

  try {
    const subs = await db.query(
      'SELECT * FROM subaccounts ORDER BY created_at ASC'
    );

    let dataMap = {};
    if (includeData) {
      const rows = await db.query(
        'SELECT subaccount_id, data FROM subaccount_data'
      );
      rows.rows.forEach(r => { dataMap[r.subaccount_id] = r.data; });
    }

    return res.status(200).json({
      subaccounts: subs.rows,
      data_map: includeData ? dataMap : null
    });
  } catch (e) {
    console.error('subaccounts-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load subaccounts' });
  }
}

exports.handler = wrap(handler);
