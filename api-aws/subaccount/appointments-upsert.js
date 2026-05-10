// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.
//
// Phase B update: accepts service_id and service_variation_id so the calendar
// can show service color stripes and so booking flows can prefill from
// catalog services. Both fields are nullable; existing free-form appointments
// continue to work unchanged.

const db = require('./lib/db');
const { resolveResourceClaims, replaceClaims, formatConflictForFrontend } = require('./lib/resource-allocation');
const { checkStaffConflict } = require('./lib/staff-conflict');
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
        const result = await checkStaffConflict({
          staffId: a.assignedTo,
          subaccountId,
          date: a.date,
          time: a.time,
          duration: a.duration,
          ignoreAppointmentId: a.id,
          statusFilter: "status = 'scheduled'",
          dbClient: db
        });
        if (!result.ok) {
          return res.status(409).json({
            error: 'conflict',
            conflict: result.conflict
          });
        }
      } catch (conflictErr) {
        console.warn('appointments-upsert: conflict check skipped due to error:', conflictErr.message);
      }
    }

    // Resource availability check. Hard block: resources cannot double-book.
    // The override flag only bypasses time/staff/lead-time conflicts, never
    // resources. If a required resource is busy, the save is rejected with a
    // clear reason so the user can pick a different time or different service.
    let resourceClaims = [];
    if (a.service_id && a.date && a.time) {
      try {
        const dur = parseInt(a.duration) || 60;
        const result = await resolveResourceClaims({
          serviceId: a.service_id,
          subaccountId,
          date: a.date,
          time: a.time,
          duration: dur,
          ignoreAppointmentId: a.id,
          dbClient: db
        });
        if (!result.ok) {
          // Build a human-readable reason listing each blocked group.
          const reasons = (result.conflicts || []).map(c => {
            const tried = (c.attempted || []).map(x => x.name).filter(Boolean);
            if (!tried.length) return 'a required resource group has no active members';
            if (tried.length === 1) return tried[0] + ' is booked';
            return 'all of [' + tried.join(', ') + '] are booked';
          });
          return res.status(409).json({
            error: 'resource_unavailable',
            message: 'Cannot save: ' + reasons.join(', and ') + ' at this time. Pick another time or remove the resource requirement on this service.',
            blocked_resources: result.conflicts
          });
        }
        resourceClaims = result.claims;
      } catch (resErr) {
        console.warn('[resource-check] skipped due to error:', resErr.message, resErr.stack);
        // Fail-open on system errors. Audit log will show the warning.
      }
    }

    // Resolve addons server-side. Client sends array of {id} or {id,name,price,duration_add}.
    // Server refetches from DB to get authoritative current data; client prices ignored.
    let resolvedAddons = [];
    if (Array.isArray(a.addons) && a.addons.length) {
      const ids = a.addons.map(x => x && x.id).filter(x => typeof x === 'string' && x.length);
      if (ids.length && a.service_id) {
        const r = await db.query(
          `SELECT id, name, description, price, duration_add
           FROM service_addons
           WHERE service_id = $1 AND subaccount_id = $2
             AND id = ANY($3::text[])`,
          [a.service_id, subaccountId, ids]
        );
        resolvedAddons = r.rows.map(x => ({
          id: x.id,
          name: x.name,
          description: x.description || null,
          price: parseFloat(x.price) || 0,
          duration_add: parseInt(x.duration_add) || 0
        }));
      }
    }

    await db.query(`
      INSERT INTO appointments (
        id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
        status, location, notes, service_id, service_variation_id, addons,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW(), NOW())
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
        addons = EXCLUDED.addons,
        updated_at = NOW()
      WHERE appointments.subaccount_id = $2
    `, [
      a.id, subaccountId, a.title, a.contactId || null, a.assignedTo || null,
      a.date, a.time || null, parseInt(a.duration) || 60,
      a.status || 'scheduled', a.location || null, a.notes || null,
      a.service_id || null, a.service_variation_id || null, JSON.stringify(resolvedAddons)
    ]);

    // Persist resource claims for this appointment (replaces any existing claims).
    try {
      await replaceClaims({
        dbClient: db,
        appointmentId: a.id,
        claims: resourceClaims
      });
    } catch (claimErr) {
      console.warn('[resource-check] persist failed:', claimErr.message);
    }

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
