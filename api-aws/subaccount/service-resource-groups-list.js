// GET /api/subaccount/service-resource-groups-list
// Body: { service_id: "..." }
// Returns the resource group structure for a single service.
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

    const groupsRes = await db.query(
      `SELECT id, service_id, label, display_order
       FROM service_resource_groups
       WHERE service_id = $1 AND subaccount_id = $2
       ORDER BY display_order, id`,
      [serviceId, auth.subaccount_id]
    );

    if (!groupsRes.rows.length) {
      return res.status(200).json({ success: true, groups: [] });
    }

    const groupIds = groupsRes.rows.map(g => g.id);
    const membersRes = await db.query(
      `SELECT group_id, resource_id FROM service_resource_group_members
       WHERE group_id = ANY($1::text[])`,
      [groupIds]
    );

    // Bucket members per group_id
    const membersByGroup = {};
    for (const m of membersRes.rows) {
      if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
      membersByGroup[m.group_id].push(m.resource_id);
    }

    const groups = groupsRes.rows.map(g => ({
      id: g.id,
      service_id: g.service_id,
      label: g.label || null,
      display_order: g.display_order,
      resource_ids: membersByGroup[g.id] || []
    }));

    return res.status(200).json({ success: true, groups });
  } catch (e) {
    console.error('service-resource-groups-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load resource groups' });
  }
}
exports.handler = wrap(handler);
