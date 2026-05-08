// POST /api/subaccount/service-addons-upsert
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const a = req.body || {};
  if (!a.id) return res.status(400).json({ error: 'id is required' });
  if (!a.service_id) return res.status(400).json({ error: 'service_id is required' });
  if (!a.name) return res.status(400).json({ error: 'name is required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Verify service belongs to this subaccount
    const svc = await db.query(
      'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
      [a.service_id, subaccountId]
    );
    if (svc.rows.length === 0) return res.status(403).json({ error: 'Service not found' });

    await db.query(`
      INSERT INTO service_addons (
        id, service_id, subaccount_id, name, description, price,
        duration_add, active, display_order, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name,
        description=EXCLUDED.description,
        price=EXCLUDED.price,
        duration_add=EXCLUDED.duration_add,
        active=EXCLUDED.active,
        display_order=EXCLUDED.display_order,
        updated_at=NOW()
      WHERE service_addons.subaccount_id=$3
    `, [
      a.id, a.service_id, subaccountId, a.name,
      a.description || null,
      a.price != null ? parseFloat(a.price) : 0,
      parseInt(a.duration_add) || 0,
      a.active !== false,
      parseInt(a.display_order) || 0
    ]);

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_addon.upsert', targetType: 'service_addon',
      targetId: a.id, targetSubaccountId: subaccountId,
      metadata: { name: a.name, service_id: a.service_id, price: parseFloat(a.price) || 0 }
    });

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('service-addons-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save add-on' });
  }
}
exports.handler = wrap(handler);
