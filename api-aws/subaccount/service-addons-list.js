// POST /api/subaccount/service-addons-list
// Returns active and inactive add-ons for a given service
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { service_id } = req.body || {};
  if (!service_id) return res.status(400).json({ error: 'service_id is required' });
  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      `SELECT id, service_id, subaccount_id, name, description, price,
              duration_add, active, display_order, created_at, updated_at
       FROM service_addons
       WHERE service_id=$1 AND subaccount_id=$2
       ORDER BY display_order ASC, name ASC`,
      [service_id, subaccountId]
    );
    return res.status(200).json({ success: true, addons: r.rows });
  } catch (e) {
    console.error('service-addons-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load add-ons' });
  }
}
exports.handler = wrap(handler);
