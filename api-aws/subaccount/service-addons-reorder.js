// POST /api/subaccount/service-addons-reorder
// Body: { service_id, ordered_ids: [id1, id2, id3] }
// Updates display_order for each add-on based on array position.
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { service_id, ordered_ids } = req.body || {};
  if (!service_id) return res.status(400).json({ error: 'service_id is required' });
  if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: 'ordered_ids must be array' });
  const subaccountId = auth.subaccount_id;

  try {
    // Verify service belongs to subaccount
    const svc = await db.query(
      'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
      [service_id, subaccountId]
    );
    if (svc.rows.length === 0) return res.status(403).json({ error: 'Service not found' });

    // Update display_order for each id, scoped to this service+subaccount
    for (let i = 0; i < ordered_ids.length; i++) {
      await db.query(
        `UPDATE service_addons SET display_order=$1, updated_at=NOW()
         WHERE id=$2 AND service_id=$3 AND subaccount_id=$4`,
        [i, ordered_ids[i], service_id, subaccountId]
      );
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_addon.reorder', targetType: 'service_addon',
      targetId: service_id, targetSubaccountId: subaccountId,
      metadata: { service_id, count: ordered_ids.length }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('service-addons-reorder error:', e.message);
    return res.status(500).json({ error: 'Failed to reorder add-ons' });
  }
}
exports.handler = wrap(handler);
