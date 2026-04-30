// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.

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
  if (!a.title) return res.status(400).json({ error: 'title is required' });
  if (!a.date) return res.status(400).json({ error: 'date is required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Determine if this is a new appointment (for audit action label)
    const existing = await db.query(
      'SELECT id FROM appointments WHERE id = $1 AND subaccount_id = $2',
      [a.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    await db.query(`
      INSERT INTO appointments (id, subaccount_id, title, contact_id, assigned_to, date, time, duration, status, location, notes, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        contact_id = EXCLUDED.contact_id,
        assigned_to = EXCLUDED.assigned_to,
        date = EXCLUDED.date,
        time = EXCLUDED.time,
        duration = EXCLUDED.duration,
        status = EXCLUDED.status,
        location = EXCLUDED.location,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      WHERE appointments.subaccount_id = $2
    `, [
      a.id, subaccountId, a.title, a.contactId || null, a.assignedTo || null,
      a.date, a.time || null, parseInt(a.duration) || 60,
      a.status || 'scheduled', a.location || null, a.notes || null
    ]);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isNew ? 'subaccount.appointment.create' : 'subaccount.appointment.update',
      targetType: 'appointment',
      targetId: a.id,
      targetSubaccountId: subaccountId,
      metadata: {
        title: a.title,
        date: a.date,
        time: a.time,
        contact_id: a.contactId,
        assigned_to: a.assignedTo,
        status: a.status
      }
    });

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('appointments-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save appointment' });
  }
}

exports.handler = wrap(handler);
