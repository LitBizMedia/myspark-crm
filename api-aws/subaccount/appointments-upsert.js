// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.
//
// Phase B update: accepts service_id and service_variation_id so the calendar
// can show service color stripes and so booking flows can prefill from
// catalog services. Both fields are nullable; existing free-form appointments
// continue to work unchanged.

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

    // Race-condition check: detect double-booking by another user that wasn't
    // visible in this client's stale state. Frontend has its own check using
    // local db.appointments, but if another staff member just booked the same
    // slot, that data wouldn't be on this client until the next refresh.
    //
    // The frontend can already override conflicts intentionally (legitimate
    // overlapping appointments do exist). When the user has chosen to override,
    // they pass `override: true` in the body and we skip this check.
    //
    // Only checks scheduled status; cancelled/no-show appointments don't block.
    //
    // Time column may be stored as TEXT in this schema, so we cast explicitly
    // to time on both sides of every comparison. We also wrap the entire check
    // in a try/catch so any unexpected error degrades to "skip the check" rather
    // than blocking a legitimate save.
    if (a.assignedTo && a.date && a.time && !req.body.override) {
      try {
        const dur = parseInt(a.duration) || 60;
        const conflict = await db.query(`
          SELECT id, title, time, duration FROM appointments
          WHERE subaccount_id = $1
            AND assigned_to = $2
            AND date = $3
            AND status = 'scheduled'
            AND id != $4
            AND time IS NOT NULL
            AND (
              -- New appt starts during existing one
              ($5::time >= time::time AND $5::time < (time::time + (duration || ' minutes')::interval))
              OR
              -- New appt ends during existing one
              (($5::time + ($6 || ' minutes')::interval) > time::time AND $5::time < time::time)
              OR
              -- New appt fully contains existing one
              ($5::time <= time::time AND ($5::time + ($6 || ' minutes')::interval) >= (time::time + (duration || ' minutes')::interval))
            )
          LIMIT 1
        `, [subaccountId, a.assignedTo, a.date, a.id, a.time, String(dur)]);

        if (conflict.rows.length > 0) {
          const c = conflict.rows[0];
          return res.status(409).json({
            error: 'conflict',
            conflict: {
              id: c.id,
              title: c.title,
              time: typeof c.time === 'string' ? c.time : (c.time && c.time.toString().slice(0,5)),
              duration: c.duration
            }
          });
        }
      } catch (conflictErr) {
        // If the conflict check fails (bad time format on existing rows, schema
        // surprise, etc.) we LOG and SKIP the check rather than blocking the
        // save. Frontend already has its own conflict UI; missing the server
        // check is a soft failure, not a hard one.
        console.warn('appointments-upsert: conflict check skipped due to error:', conflictErr.message);
      }
    }

    await db.query(`
      INSERT INTO appointments (
        id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
        status, location, notes, service_id, service_variation_id,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
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
        updated_at = NOW()
      WHERE appointments.subaccount_id = $2
    `, [
      a.id, subaccountId, a.title, a.contactId || null, a.assignedTo || null,
      a.date, a.time || null, parseInt(a.duration) || 60,
      a.status || 'scheduled', a.location || null, a.notes || null,
      a.service_id || null, a.service_variation_id || null
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
        service_variation_id: a.service_variation_id || null
      }
    });

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('appointments-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save appointment' });
  }
}

exports.handler = wrap(handler);
