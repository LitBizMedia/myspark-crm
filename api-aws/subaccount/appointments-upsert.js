// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.
//
// Phase B update: accepts service_id and service_variation_id so the calendar
// can show service color stripes and so booking flows can prefill from
// catalog services. Both fields are nullable; existing free-form appointments
// continue to work unchanged.
//
// Phase C.1 update: persists buffer_before and buffer_after. Frontend has been
// sending these all along but the Lambda was silently dropping them. Columns
// added to appointments table in 2026-05-03-phase-c-1-buffers.sql migration.

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
    // Validate service_id belongs to this subaccount if provided.
    if (a.service_id) {
      const svc = await db.query(
        'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
        [a.service_id, subaccountId]
      );
      if (svc.rows.length === 0) {
        return res.status(400).json({ error: 'service_id not found in this subaccount' });
      }
    }
    // Validate variation belongs to the service if both are provided.
    if (a.service_variation_id && a.service_id) {
      const variation = await db.query(
        'SELECT id FROM service_variations WHERE id=$1 AND service_id=$2',
        [a.service_variation_id, a.service_id]
      );
      if (variation.rows.length === 0) {
        return res.status(400).json({ error: 'service_variation_id does not belong to the given service' });
      }
    }

    // Determine if this is a new appointment (for audit action label)
    const existing = await db.query(
      'SELECT id FROM appointments WHERE id = $1 AND subaccount_id = $2',
      [a.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    // Coerce buffer values: accept number or numeric string, default 0.
    const bufferBefore = parseInt(a.buffer_before, 10);
    const bufferAfter  = parseInt(a.buffer_after, 10);

    await db.query(`
      INSERT INTO appointments (
        id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
        status, location, notes, service_id, service_variation_id,
        buffer_before, buffer_after,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
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
        service_id = EXCLUDED.service_id,
        service_variation_id = EXCLUDED.service_variation_id,
        buffer_before = EXCLUDED.buffer_before,
        buffer_after = EXCLUDED.buffer_after,
        updated_at = NOW()
      WHERE appointments.subaccount_id = $2
    `, [
      a.id, subaccountId, a.title, a.contactId || null, a.assignedTo || null,
      a.date, a.time || null, parseInt(a.duration) || 60,
      a.status || 'scheduled', a.location || null, a.notes || null,
      a.service_id || null, a.service_variation_id || null,
      isNaN(bufferBefore) ? 0 : bufferBefore,
      isNaN(bufferAfter)  ? 0 : bufferAfter
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
        status: a.status,
        service_id: a.service_id || null,
        service_variation_id: a.service_variation_id || null,
        buffer_before: isNaN(bufferBefore) ? 0 : bufferBefore,
        buffer_after:  isNaN(bufferAfter)  ? 0 : bufferAfter
      }
    });

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('appointments-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save appointment' });
  }
}

exports.handler = wrap(handler);
