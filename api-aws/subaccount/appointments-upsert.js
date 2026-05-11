// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.
//
// Phase B update: accepts service_id and service_variation_id so the calendar
// can show service color stripes and so booking flows can prefill from
// catalog services. Both fields are nullable; existing free-form appointments
// continue to work unchanged.

const db = require('./lib/db');
const { resolveResourceClaims, resolveMultipleResourceClaims, replaceClaims, persistClaims } = require('./lib/resource-allocation');
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

    // Group booking detection: fetch service flags so we know whether to
    // process this as a multi-client/multi-staff group booking or a normal one.
    let groupSvc = null;
    if (a.service_id) {
      const svcDetail = await db.query(
        `SELECT id, group_capable, group_staff_count, group_size_min, group_size_max,
                price, assigned_staff
         FROM services WHERE id=$1 AND subaccount_id=$2`,
        [a.service_id, subaccountId]
      );
      if (svcDetail.rows.length) groupSvc = svcDetail.rows[0];
    }
    const isGroupBooking = !!(groupSvc && groupSvc.group_capable
      && Array.isArray(a.clients) && a.clients.length
      && Array.isArray(a.staff) && a.staff.length);

    // Group booking validation: clients within size range, staff EXACTLY matches
    // group_staff_count, every staff in the eligible pool. Bail BEFORE any writes.
    if (isGroupBooking) {
      const cMin = parseInt(groupSvc.group_size_min) || 1;
      const cMax = parseInt(groupSvc.group_size_max) || cMin;
      const sCount = parseInt(groupSvc.group_staff_count) || 2;
      if (a.clients.length < cMin || a.clients.length > cMax) {
        return res.status(400).json({
          error: 'invalid_group_size',
          message: 'This service requires ' + cMin + ' to ' + cMax + ' clients (got ' + a.clients.length + ').'
        });
      }
      if (a.staff.length !== sCount) {
        return res.status(400).json({
          error: 'invalid_staff_count',
          message: 'This service requires exactly ' + sCount + ' staff (got ' + a.staff.length + ').'
        });
      }
      const eligible = Array.isArray(groupSvc.assigned_staff) ? groupSvc.assigned_staff
        : (typeof groupSvc.assigned_staff === 'string' ? JSON.parse(groupSvc.assigned_staff || '[]') : []);
      const ineligible = a.staff.filter(s => eligible.indexOf(s.staff_id || s) < 0);
      if (ineligible.length) {
        return res.status(400).json({
          error: 'ineligible_staff',
          message: 'Some staff members are not in the eligible pool for this service.'
        });
      }
      // Validate at least one client flagged primary
      const primaries = a.clients.filter(c => c.is_primary);
      if (primaries.length !== 1) {
        return res.status(400).json({
          error: 'invalid_primary',
          message: 'Exactly one client must be marked as primary booker.'
        });
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

    // Group booking: every assigned staff must be free at this time.
    if (isGroupBooking && !req.body.override) {
      const dur = parseInt(a.duration) || 60;
      for (const sObj of a.staff) {
        const sid = sObj.staff_id || sObj;
        try {
          const r = await checkStaffConflict({
            staffId: sid,
            subaccountId,
            date: a.date,
            time: a.time,
            duration: dur,
            ignoreAppointmentId: a.id,
            statusFilter: "status = 'scheduled'",
            dbClient: db
          });
          if (!r.ok) {
            return res.status(409).json({
              error: 'group_staff_conflict',
              conflict_staff_id: sid,
              conflict: r.conflict,
              message: 'One of the assigned staff is double-booked at this time.'
            });
          }
        } catch (cErr) {
          console.warn('group conflict check skipped:', cErr.message);
        }
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

    if (!isGroupBooking) {
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
    } else {
      // GROUP BOOKING TRANSACTIONAL PATH
      // All writes (appointment + appointment_clients + appointment_staff +
      // appointment_resources) succeed together or roll back as one.
      const primaryClient = a.clients.find(c => c.is_primary);
      const firstStaff = a.staff[0];
      const primaryContactId = primaryClient.contact_id || primaryClient;
      const firstStaffId = firstStaff.staff_id || firstStaff;

      // Resource resolution before opening a transaction. If resources can't be
      // claimed, return 409 immediately without writing anything.
      let groupClaims = [];
      try {
        const r = await resolveMultipleResourceClaims({
          serviceId: a.service_id,
          subaccountId,
          date: a.date,
          time: a.time,
          duration: parseInt(a.duration) || 60,
          ignoreAppointmentId: a.id,
          count: a.clients.length,
          dbClient: db
        });
        if (!r.ok) {
          const reasons = (r.conflicts || []).map(c => {
            const tried = (c.attempted || []).map(x => x.name).filter(Boolean);
            if (!tried.length) return 'a required resource is unavailable';
            return c.reason || ('resources busy: ' + tried.join(', '));
          });
          return res.status(409).json({
            error: 'group_resource_conflict',
            message: 'Resources are not available for this group booking. ' + reasons.join('; ')
          });
        }
        groupClaims = r.claims || [];
      } catch (resErr) {
        console.warn('group resource resolution failed:', resErr.message);
        // Fall through; create booking without resource claims rather than
        // hard-fail. Calendar UI will still show it.
      }

      try {
        await db.transaction(async (client) => {
          // 1. Upsert appointment row. Legacy contact_id and assigned_to
          //    populated from primary booker and first staff so old reads
          //    that join through those columns still work.
          await client.query(`
            INSERT INTO appointments (
              id, subaccount_id, title, date, time, duration,
              contact_id, assigned_to, notes, status, location,
              buffer_before, buffer_after,
              service_id, service_variation_id, addons, price,
              created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              NOW(),NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
              title=EXCLUDED.title, date=EXCLUDED.date, time=EXCLUDED.time,
              duration=EXCLUDED.duration, contact_id=EXCLUDED.contact_id,
              assigned_to=EXCLUDED.assigned_to,
              notes=EXCLUDED.notes, status=EXCLUDED.status,
              location=EXCLUDED.location,
              buffer_before=EXCLUDED.buffer_before,
              buffer_after=EXCLUDED.buffer_after,
              service_id=EXCLUDED.service_id,
              service_variation_id=EXCLUDED.service_variation_id,
              addons=EXCLUDED.addons,
              price=EXCLUDED.price,
              updated_at=NOW()
            WHERE appointments.subaccount_id=$2
          `, [
            a.id, subaccountId, a.title, a.date, a.time || null,
            parseInt(a.duration) || null,
            primaryContactId, firstStaffId,
            a.notes || null,
            a.status || 'scheduled',
            a.location || null,
            parseInt(a.buffer_before) || 0,
            parseInt(a.buffer_after) || 0,
            a.service_id || null, a.service_variation_id || null,
            a.addons ? JSON.stringify(a.addons) : null,
            a.price != null ? parseFloat(a.price) : null
          ]);

          // 2. Replace appointment_clients
          await client.query('DELETE FROM appointment_clients WHERE appointment_id=$1', [a.id]);
          for (const c of a.clients) {
            await client.query(
              'INSERT INTO appointment_clients (appointment_id, contact_id, is_primary) VALUES ($1, $2, $3)',
              [a.id, c.contact_id || c, !!c.is_primary]
            );
          }

          // 3. Replace appointment_staff
          await client.query('DELETE FROM appointment_staff WHERE appointment_id=$1', [a.id]);
          for (let i = 0; i < a.staff.length; i++) {
            const sObj = a.staff[i];
            await client.query(
              'INSERT INTO appointment_staff (appointment_id, staff_id, display_order) VALUES ($1, $2, $3)',
              [a.id, sObj.staff_id || sObj, i]
            );
          }

          // 4. Replace resource claims
          await client.query('DELETE FROM appointment_resources WHERE appointment_id=$1', [a.id]);
          for (const claim of groupClaims) {
            await client.query(
              'INSERT INTO appointment_resources (appointment_id, resource_id, group_id) VALUES ($1, $2, $3)',
              [a.id, claim.resource_id, claim.group_id]
            );
          }
        });
      } catch (txErr) {
        console.error('group booking transaction failed:', txErr.message);
        return res.status(500).json({ error: 'Failed to save group booking. Try again.' });
      }
    }

    // Defensive cleanup: if a NON-group appointment was previously a group
    // (e.g., service was just un-flagged as group_capable), strip stale join
    // table rows so reads don't return phantom clients/staff.
    if (!isGroupBooking) {
      try {
        await db.query('DELETE FROM appointment_clients WHERE appointment_id=$1', [a.id]);
        await db.query('DELETE FROM appointment_staff WHERE appointment_id=$1', [a.id]);
      } catch (cleanErr) {
        console.warn('appt cleanup failed (non-fatal):', cleanErr.message);
      }
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
        service_variation_id: a.service_variation_id || null,
        group_booking: isGroupBooking || false,
        group_client_count: isGroupBooking ? a.clients.length : null,
        group_staff_count: isGroupBooking ? a.staff.length : null
      }
    });

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('appointments-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save appointment' });
  }
}

exports.handler = wrap(handler);
