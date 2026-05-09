// POST /api/subaccount/service-resources-list
// Body: { service_id }
// Returns flat list of resource_ids attached to this service.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const serviceId = (req.body && req.body.service_id) || null;
    if (!serviceId) return res.status(400).json({ error: 'service_id is required' });

    const r = await db.query(
      `SELECT resource_id, display_order
       FROM service_resources
       WHERE service_id = $1 AND subaccount_id = $2
       ORDER BY display_order, resource_id`,
      [serviceId, auth.subaccount_id]
    );
    return res.status(200).json({
      success: true,
      resource_ids: r.rows.map(x => x.resource_id)
    });
  } catch (e) {
    console.error('service-resources-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load service resources' });
  }
}
exports.handler = wrap(handler);
