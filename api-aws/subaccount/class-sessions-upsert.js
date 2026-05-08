// POST /api/subaccount/class-sessions-upsert
// Phase A update: accepts series_id, is_override, and price columns.
// These fields stay null/false unless explicitly provided. The recurrence
// generator (Phase D) will populate series_id for generated sessions.
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
      'SELECT id, series_id FROM class_sessions WHERE id=$1 AND subaccount_id=$2',
      [c.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;
    const existingRow = existing.rows[0];

    // If updating an existing session that is part of a series, and the
    // request did not explicitly set is_override, flip it to true automatically.
    // This protects manually-edited sessions from being overwritten by future
    // template regenerations. New sessions and explicit values pass through.
    let isOverride = c.is_override === true;
    if (!isNew && existingRow && existingRow.series_id && c.is_override === undefined) {
      isOverride = true;
    }

    await db.query(`
      INSERT INTO class_sessions (
        id, subaccount_id, service_id, instructor_id, title, date, time,
        duration, capacity, location, notes, status, participants,
        series_id, is_override, price,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,
        NOW(),NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        service_id=EXCLUDED.service_id,
        instructor_id=EXCLUDED.instructor_id,
        title=EXCLUDED.title, date=EXCLUDED.date, time=EXCLUDED.time,
        duration=EXCLUDED.duration, capacity=EXCLUDED.capacity,
        location=EXCLUDED.location, notes=EXCLUDED.notes,
        status=EXCLUDED.status,
        is_override=EXCLUDED.is_override,
        price=EXCLUDED.price,
        updated_at=NOW()
      WHERE class_sessions.subaccount_id=$2
    `, [
      c.id, subaccountId, c.service_id||null, c.instructor_id||null,
      c.title, c.date, c.time||null,
      parseInt(c.duration)||60, parseInt(c.capacity)||10,
      c.location||null, c.notes||null,
      c.status||'scheduled',
      JSON.stringify(c.participants||[]),
      c.series_id || null,
      isOverride,
      c.price != null ? parseFloat(c.price) : null
    ]);

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action: isNew ? 'subaccount.class_session.create' : 'subaccount.class_session.update',
      targetType:'class_session', targetId:c.id,
      targetSubaccountId:subaccountId,
      metadata:{ title:c.title, date:c.date, is_override: isOverride, has_series: !!c.series_id }
    });

    return res.status(200).json({ success:true, id:c.id, is_override: isOverride });
  } catch(e) {
    console.error('class-sessions-upsert error:', e.message);
    return res.status(500).json({ error:'Failed to save class session' });
  }
}
exports.handler = wrap(handler);
