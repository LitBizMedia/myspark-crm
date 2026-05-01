// POST /api/subaccount/services-upsert
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const s = req.body || {};
  if (!s.id) return res.status(400).json({ error: 'id is required' });
  if (!s.name) return res.status(400).json({ error: 'name is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
      [s.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    await db.query(`
      INSERT INTO services (
        id, subaccount_id, name, description, category, type, color, price,
        buffer_before, buffer_after, assigned_staff, allow_client_choose_staff,
        availability, booking_lead_time_hours, booking_advance_days, active,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, description=EXCLUDED.description,
        category=EXCLUDED.category, type=EXCLUDED.type,
        color=EXCLUDED.color, price=EXCLUDED.price,
        buffer_before=EXCLUDED.buffer_before, buffer_after=EXCLUDED.buffer_after,
        assigned_staff=EXCLUDED.assigned_staff,
        allow_client_choose_staff=EXCLUDED.allow_client_choose_staff,
        availability=EXCLUDED.availability,
        booking_lead_time_hours=EXCLUDED.booking_lead_time_hours,
        booking_advance_days=EXCLUDED.booking_advance_days,
        active=EXCLUDED.active, updated_at=NOW()
      WHERE services.subaccount_id=$2
    `, [
      s.id, subaccountId, s.name, s.description||null, s.category||null,
      s.type||'individual', s.color||'#6b21ea',
      s.price!=null ? parseFloat(s.price) : null,
      parseInt(s.buffer_before)||0, parseInt(s.buffer_after)||0,
      JSON.stringify(s.assigned_staff||[]),
      s.allow_client_choose_staff !== false,
      JSON.stringify(s.availability||{}),
      parseInt(s.booking_lead_time_hours)||0,
      parseInt(s.booking_advance_days)||60,
      s.active !== false
    ]);

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action: isNew ? 'subaccount.service.create' : 'subaccount.service.update',
      targetType:'service', targetId:s.id,
      targetSubaccountId:subaccountId,
      metadata:{ name:s.name, type:s.type }
    });

    return res.status(200).json({ success:true, id:s.id });
  } catch(e) {
    console.error('services-upsert error:', e.message);
    return res.status(500).json({ error:'Failed to save service' });
  }
}
exports.handler = wrap(handler);
