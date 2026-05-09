// POST /api/subaccount/service-resources-upsert
// Replaces ALL resource links for a service.
// Body: { service_id, resource_ids: [...] }
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const serviceId = b.service_id || null;
    const incomingIds = Array.isArray(b.resource_ids) ? b.resource_ids : [];
    if (!serviceId) return res.status(400).json({ error: 'service_id is required' });

    // Verify service belongs to this subaccount
    const svcCheck = await db.query(
      `SELECT id FROM services WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
      [serviceId, auth.subaccount_id]
    );
    if (!svcCheck.rows.length) return res.status(404).json({ error: 'Service not found' });

    // Dedupe + verify resources belong to this subaccount
    const seen = {};
    const cleanIds = [];
    for (const rid of incomingIds) {
      if (typeof rid === 'string' && rid && !seen[rid]) {
        seen[rid] = true;
        cleanIds.push(rid);
      }
    }
    if (cleanIds.length) {
      const resCheck = await db.query(
        `SELECT id FROM resources WHERE id = ANY($1::text[]) AND subaccount_id = $2`,
        [cleanIds, auth.subaccount_id]
      );
      if (resCheck.rows.length !== cleanIds.length) {
        return res.status(400).json({ error: 'One or more resources not found in this account' });
      }
    }

    // Replace-all: delete current, insert new in order.
    await db.query(
      `DELETE FROM service_resources WHERE service_id = $1 AND subaccount_id = $2`,
      [serviceId, auth.subaccount_id]
    );
    for (let i = 0; i < cleanIds.length; i++) {
      await db.query(
        `INSERT INTO service_resources (service_id, resource_id, subaccount_id, display_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [serviceId, cleanIds[i], auth.subaccount_id, i]
      );
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_resources.upsert',
      targetType: 'service', targetId: serviceId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { resource_count: cleanIds.length }
    });

    return res.status(200).json({ success: true, resource_count: cleanIds.length });
  } catch (e) {
    console.error('service-resources-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save service resources' });
  }
}
exports.handler = wrap(handler);
