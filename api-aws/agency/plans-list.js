// api/agency/plans-list.js (Lambda version)
// GET /api/agency/plans-list[?subaccount_id=X]
// Returns all subaccount_plans, or one if subaccount_id query param given.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const { subaccount_id } = req.query || {};

  try {
    let r;
    if (subaccount_id) {
      r = await db.query(
        'SELECT * FROM subaccount_plans WHERE subaccount_id = $1',
        [subaccount_id]
      );
    } else {
      r = await db.query('SELECT * FROM subaccount_plans ORDER BY created_at ASC');
    }
    return res.status(200).json({ plans: r.rows });
  } catch (e) {
    console.error('plans-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
}

exports.handler = wrap(handler);
