// api/agency/subaccount-data-get.js (Lambda version)
// GET /api/agency/subaccount-data-get?id=X
// Returns one subaccount's bulk data JSONB.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const { id } = req.query || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const r = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
      [id]
    );
    return res.status(200).json({ data: r.rows[0]?.data || null });
  } catch (e) {
    console.error('subaccount-data-get error:', e.message);
    return res.status(500).json({ error: 'Failed to load data' });
  }
}

exports.handler = wrap(handler);
