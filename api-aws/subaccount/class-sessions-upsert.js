// POST /api/subaccount/class-sessions-upsert
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const c = req.body || {};
  if (!c.id) return res.status(400).json({ error: 'id is required' });
  if (!c.title) return res.status(400).json({ error: 'title is required' });
  if (!c.date) return res.status(400).json({ error: 'date is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id FROM class_sessions WHERE id=$1 AND subaccount_id=$2',
      [c.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    await db.query(`
      INSERT INTO class_sessions (
        id, subaccount_id, service_id, instructor_id, title, date, time,
        duration, capacity, location, notes, status, participants, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        service_id=EXCLUDED.service_id,
        instructor_id=EXCLUDED.instructor_id,
        title=EXCLUDED.title, date=EXCLUDED.date, time=EXCLUDED.time,
        duration=EXCLUDED.duration, capacity=EXCLUDED.capacity,
        location=EXCLUDED.location, notes=EXCLUDED.notes,
        status=EXCLUDED.status, updated_at=NOW()
      WHERE class_sessions.subaccount_id=$2
    `, [
      c.id, subaccountId, c.service_id||null, c.instructor_id||null,
      c.title, c.date, c.time||null,
      parseInt(c.duration)||60, parseInt(c.capacity)||10,
      c.location||null, c.notes||null,
      c.status||'scheduled',
      JSON.stringify(c.participants||[])
    ]);

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action: isNew ? 'subaccount.class_session.create' : 'subaccount.class_session.update',
      targetType:'class_session', targetId:c.id,
      targetSubaccountId:subaccountId,
      metadata:{ title:c.title, date:c.date }
    });

    return res.status(200).json({ success:true, id:c.id });
  } catch(e) {
    console.error('class-sessions-upsert error:', e.message);
    return res.status(500).json({ error:'Failed to save class session' });
  }
}
exports.handler = wrap(handler);
