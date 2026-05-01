// POST /api/subaccount/service-variations-upsert
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const v = req.body || {};
  if (!v.id) return res.status(400).json({ error: 'id is required' });
  if (!v.service_id) return res.status(400).json({ error: 'service_id is required' });
  if (!v.name) return res.status(400).json({ error: 'name is required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Verify service belongs to this subaccount
    const svc = await db.query(
      'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
      [v.service_id, subaccountId]
    );
    if (svc.rows.length === 0) return res.status(403).json({ error: 'Service not found' });

    await db.query(`
      INSERT INTO service_variations (
        id, service_id, subaccount_id, name, duration, price,
        buffer_before, buffer_after, active, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, duration=EXCLUDED.duration,
        price=EXCLUDED.price, buffer_before=EXCLUDED.buffer_before,
        buffer_after=EXCLUDED.buffer_after, active=EXCLUDED.active,
        updated_at=NOW()
    `, [
      v.id, v.service_id, subaccountId, v.name,
      parseInt(v.duration)||60,
      v.price!=null ? parseFloat(v.price) : null,
      v.buffer_before!=null ? parseInt(v.buffer_before) : null,
      v.buffer_after!=null ? parseInt(v.buffer_after) : null,
      v.active !== false
    ]);

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action:'subaccount.service_variation.upsert', targetType:'service_variation',
      targetId:v.id, targetSubaccountId:subaccountId,
      metadata:{ name:v.name, service_id:v.service_id }
    });

    return res.status(200).json({ success:true, id:v.id });
  } catch(e) {
    console.error('service-variations-upsert error:', e.message);
    return res.status(500).json({ error:'Failed to save variation' });
  }
}
exports.handler = wrap(handler);
