// POST /api/subaccount/service-resource-groups-upsert
// Replaces ALL resource groups for a service. Atomic per-service.
// Body: { service_id, groups: [{ id?, resource_ids: [...] }, ...] }
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const serviceId = b.service_id || null;
    const incomingGroups = Array.isArray(b.groups) ? b.groups : [];
    if (!serviceId) return res.status(400).json({ error: 'service_id is required' });

    const svcCheck = await db.query(
      `SELECT id FROM services WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
      [serviceId, auth.subaccount_id]
    );
    if (!svcCheck.rows.length) return res.status(404).json({ error: 'Service not found' });

    // Collect all resource_ids referenced across groups for cross-tenant validation
    const allResourceIds = [];
    for (const g of incomingGroups) {
      if (Array.isArray(g.resource_ids)) {
        for (const rid of g.resource_ids) {
          if (typeof rid === 'string' && rid && allResourceIds.indexOf(rid) < 0) {
            allResourceIds.push(rid);
          }
        }
      }
    }
    if (allResourceIds.length) {
      const resCheck = await db.query(
        `SELECT id FROM resources WHERE id = ANY($1::text[]) AND subaccount_id = $2`,
        [allResourceIds, auth.subaccount_id]
      );
      if (resCheck.rows.length !== allResourceIds.length) {
        return res.status(400).json({ error: 'One or more resources not found in this account' });
      }
    }

    // Delete-and-replace pattern. CASCADE handles members.
    await db.query(
      `DELETE FROM service_resource_groups WHERE service_id = $1 AND subaccount_id = $2`,
      [serviceId, auth.subaccount_id]
    );

    // Insert fresh groups + members. Skip empty groups silently.
    let insertedGroups = 0;
    for (let i = 0; i < incomingGroups.length; i++) {
      const g = incomingGroups[i];
      const seen = {};
      const uniqueIds = [];
      if (Array.isArray(g.resource_ids)) {
        for (const rid of g.resource_ids) {
          if (typeof rid === 'string' && rid && !seen[rid]) {
            seen[rid] = true;
            uniqueIds.push(rid);
          }
        }
      }
      if (!uniqueIds.length) continue;  // skip empty groups

      const groupId = (g.id && typeof g.id === 'string') ? g.id : uid();
      await db.query(
        `INSERT INTO service_resource_groups (id, service_id, subaccount_id, display_order, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [groupId, serviceId, auth.subaccount_id, i]
      );
      for (let j = 0; j < uniqueIds.length; j++) {
        await db.query(
          `INSERT INTO service_resource_group_members (group_id, resource_id, display_order)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [groupId, uniqueIds[j], j]
        );
      }
      insertedGroups++;
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_resource_groups.upsert',
      targetType: 'service', targetId: serviceId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { group_count: insertedGroups, resource_count: allResourceIds.length }
    });

    return res.status(200).json({ success: true, group_count: insertedGroups });
  } catch (e) {
    console.error('service-resource-groups-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save resource groups' });
  }
}
exports.handler = wrap(handler);
