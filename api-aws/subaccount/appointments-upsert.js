// api/subaccount/appointments-upsert.js (Lambda version)
// POST /api/subaccount/appointments-upsert
// Creates or updates a single appointment for the authenticated subaccount.
//
// Phase B update: accepts service_id and service_variation_id so the calendar
// can show service color stripes and so booking flows can prefill from
// catalog services. Both fields are nullable; existing free-form appointments
// continue to work unchanged.

const db = require('./lib/db');
const contactsLib = require('./lib/contacts');
const { resolveResourceClaims, resolveMultipleResourceClaims, replaceClaims, persistClaims } = require('./lib/resource-allocation');
const { sendAppointmentConfirmations } = require('./lib/appointment-emails');
const { checkStaffConflict } = require('./lib/staff-conflict');
const { isTimeAvailable } = require('./lib/schedule');
const { isValidStatus } = require('./lib/appt-statuses');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const automations = require('./lib/automations');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const a = req.body || {};
  if (!a.id) return res.status(400).json({ error: 'id is required' });
  if (!a.title) return res.status(400).json({ error: 'title is required' });
  if (!a.date) return res.status(400).json({ error: 'date is required' });

  const subaccountId = auth.subaccount_id;

    // Per-service availability check. Validates booking time is within the
    // service's bookable window. Service.availability is { enabled, schedule:
    // {mon:{open,start,end}, ...} }. When null/disabled, fall back to business
    // hours from settings. If the booking falls outside, reject 409.
    if (a.service_id && a.date && a.time && !req.body.override) {
      try {
        const svcRow = await db.query(
          'SELECT availability FROM services WHERE id=$1 AND subaccount_id=$2',
          [a.service_id, subaccountId]
        );
        if (svcRow.rows.length) {
          const av = svcRow.rows[0].availability;
          let avEnabled = false, avSchedule = null;
          if (av) {
            const parsed = typeof av === 'string' ? JSON.parse(av) : av;
            avEnabled = !!parsed.enabled;
            avSchedule = parsed.schedule || null;
          }
          // Compute the day's bookable hour range
          const dayKey = (function(ds){
            const dt = new Date(ds + 'T12:00:00Z');
            return ['sun','mon','tue','wed','thu','fri','sat'][dt.getUTCDay()];
          })(a.date);
          let bookableStart = null, bookableEnd = null;
          if (avEnabled && avSchedule && avSchedule[dayKey]) {
            const d = avSchedule[dayKey];
            if (!d.open) {
              return res.status(409).json({
                error: 'service_unavailable',
                message: 'This service is not offered on that day.'
              });
            }
            bookableStart = parseInt(d.start, 10);
            bookableEnd   = parseInt(d.end, 10);
          } else if (!avEnabled) {
            // Fall back to business hours from settings.
            const subRow = await db.query(
              'SELECT settings FROM subaccounts WHERE id=$1',
              [subaccountId]
            );
            const settings = subRow.rows[0] && subRow.rows[0].settings;
            const parsedSet = settings ? (typeof settings === 'string' ? JSON.parse(settings) : settings) : {};
            const bh = parsedSet.businessHours || {};
            const d = bh[dayKey];
            if (d) {
              if (!d.open) {
                return res.status(409).json({
                  error: 'service_unavailable',
                  message: 'Business is closed on that day.'
                });
              }
              bookableStart = parseInt(d.start, 10);
              bookableEnd   = parseInt(d.end, 10);
            }
          }
          if (bookableStart != null && bookableEnd != null && !isNaN(bookableStart) && !isNaN(bookableEnd)) {
            const [hh, mm] = a.time.split(':').map(Number);
            const bookStart = hh * 60 + (mm || 0);
            const bookEnd   = bookStart + (parseInt(a.duration, 10) || 60);
            const windowStart = bookableStart * 60;
            const windowEnd   = bookableEnd   * 60;
            if (bookStart < windowStart || bookEnd > windowEnd) {
              return res.status(409).json({
                error: 'service_unavailable',
                message: 'Booking falls outside the service\'s bookable hours that day.'
              });
            }
          }
        }
      } catch (avErr) {
        console.warn('service availability check failed (non-fatal):', avErr.message);
        // Don't block on lookup errors. Frontend already validates; backend
        // is defense-in-depth.
      }
    }


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
      'SELECT id, status, contact_id FROM appointments WHERE id = $1 AND subaccount_id = $2',
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
    // Validate appointment status. Must be in the registry from lib/appt-statuses.
    // Defaults to 'scheduled' when not provided (matches DB column default).
    if (a.status && !isValidStatus(a.status)) {
      return res.status(400).json({ error: 'Invalid appointment status: ' + a.status });
    }

    // FOLLOW-UP 1: resolve EFFECTIVE buffers = MAX(payload buffer, assigned
    // staff's schedule default). Mirrors booking-submit (lines ~477-484) so the
    // staff modal stamps the same true buffer the public widget does. Used for
    // the conflict checks below AND stamped onto the row, so the backend
    // checkStaffConflict (which pads by stamped columns) stays correct for all
    // future checks against this appointment. Runs regardless of override so
    // the stamped value is always right.
    var effBufBefore = parseInt(a.buffer_before) || 0;
    var effBufAfter  = parseInt(a.buffer_after)  || 0;
    if (a.assignedTo) {
      try {
        const _bufRes = await db.query(
          'SELECT schedule FROM subaccount_users WHERE id=$1 AND subaccount_id=$2',
          [a.assignedTo, subaccountId]
        );
        if (_bufRes.rows.length && _bufRes.rows[0].schedule) {
          const _sch = _bufRes.rows[0].schedule;
          const _sb = parseInt(_sch.defaultBufferBefore) || 0;
          const _sa = parseInt(_sch.defaultBufferAfter)  || 0;
          if (_sb > effBufBefore) effBufBefore = _sb;
          if (_sa > effBufAfter)  effBufAfter  = _sa;
        }
      } catch (_bufErr) {
        console.warn('appointments-upsert: staff default buffer lookup skipped:', _bufErr.message);
      }
    }

    // FIX B: server-side enforcement of staff schedule + blackout dates.
    // The frontend modal warns about these, but a stale browser or a direct
    // API call could otherwise create an appointment during a staff member's
    // off-hours, lunch, or day-off, or on a workspace blackout date. These
    // checks close that hole. All respect the override flag, so a trusted
    // staff member can still deliberately book an exception.
    //
    // Unlike the service-availability check above (which only runs when a
    // service_id is present), these run for free-form appointments too.
    if (a.assignedTo && a.date && a.time && !req.body.override) {
      try {
        // Blackout dates (workspace-level). Source: settings.blackoutDates.
        const boRow = await db.query('SELECT settings FROM subaccounts WHERE id=$1', [subaccountId]);
        const boSettings = boRow.rows[0] && boRow.rows[0].settings
          ? (typeof boRow.rows[0].settings === 'string' ? JSON.parse(boRow.rows[0].settings) : boRow.rows[0].settings)
          : {};
        const blackoutDates = Array.isArray(boSettings.blackoutDates) ? boSettings.blackoutDates : [];
        const blackoutHit = blackoutDates.find(b => b && b.date === a.date);
        if (blackoutHit) {
          return res.status(409).json({
            error: 'blackout',
            message: blackoutHit.reason
              ? 'Bookings are disabled on ' + a.date + ' (' + blackoutHit.reason + ').'
              : 'Bookings are disabled on ' + a.date + '.'
          });
        }

        // Staff personal schedule: work hours, lunch, and date overrides.
        const schRes = await db.query(
          'SELECT schedule, date_overrides FROM subaccount_users WHERE id=$1 AND subaccount_id=$2',
          [a.assignedTo, subaccountId]
        );
        if (schRes.rows.length) {
          const staffSched = {
            schedule: schRes.rows[0].schedule || {},
            dateOverrides: schRes.rows[0].date_overrides || []
          };
          const dur = parseInt(a.duration, 10) || 60;
          if (!isTimeAvailable(staffSched, a.date, a.time, dur)) {
            return res.status(409).json({
              error: 'staff_unavailable',
              message: 'The assigned staff member is not scheduled to work at that time (off-hours, lunch, or day off).'
            });
          }

          // upsertDailyCap (GAP 1): enforce the staff member's daily booking
          // limit server-side, matching the reschedule + widget paths. Counts
          // active appointments for this staff on this date, excluding this
          // appointment (a.id excludes self on edits; on a new appointment the
          // fresh id matches nothing). Override bypasses (this whole block is
          // already !override-guarded).
          var _capVal = (schRes.rows[0].schedule && schRes.rows[0].schedule.maxBookingsPerDay != null
            && parseInt(schRes.rows[0].schedule.maxBookingsPerDay) > 0)
            ? parseInt(schRes.rows[0].schedule.maxBookingsPerDay) : null;
          if (_capVal != null) {
            const _capRes = await db.query(
              `SELECT COUNT(*)::int AS n
                 FROM appointments
                WHERE subaccount_id = $1
                  AND date = $2
                  AND assigned_to = $3
                  AND id != $4
                  AND status NOT IN ('cancelled','rescheduled')`,
              [subaccountId, a.date, a.assignedTo, a.id]
            );
            const _dayN = _capRes.rows[0] ? _capRes.rows[0].n : 0;
            if (_dayN >= _capVal) {
              return res.status(409).json({
                error: 'daily_cap',
                message: 'The assigned staff member has reached their daily booking limit (' + _capVal + ') on ' + a.date + '.'
              });
            }
          }
        }
      } catch (schErr) {
        // Soft-fail: degrade to skipping these checks rather than blocking a
        // legitimate save if something unexpected happens. Overlap + service
        // checks still apply.
        console.warn('appointments-upsert: staff-schedule/blackout check skipped:', schErr.message);
      }
    }

    if (a.assignedTo && a.date && a.time && !req.body.override) {
      try {
        const result = await checkStaffConflict({
          staffId: a.assignedTo,
          subaccountId,
          date: a.date,
          time: a.time,
          duration: a.duration,
          ignoreAppointmentId: a.id,
          statusFilter: "status NOT IN ('completed','cancelled','no-show','rescheduled')",
          bufferBefore: effBufBefore,
          bufferAfter: effBufAfter,
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
            statusFilter: "status NOT IN ('completed','cancelled','no-show','rescheduled')",
            bufferBefore: effBufBefore,
            bufferAfter: effBufAfter,
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
        buffer_before, buffer_after,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, NOW(), NOW())
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
        buffer_before = EXCLUDED.buffer_before,
        buffer_after = EXCLUDED.buffer_after,
        updated_at = NOW()
      WHERE appointments.subaccount_id = $2
    `, [
      a.id, subaccountId, a.title, a.contactId || null, a.assignedTo || null,
      a.date, a.time || null, parseInt(a.duration) || 60,
      a.status || 'scheduled', a.location || null, a.notes || null,
      a.service_id || null, a.service_variation_id || null, JSON.stringify(resolvedAddons),
      effBufBefore, effBufAfter
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
            effBufBefore,
            effBufAfter,
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
        group_staff_count: isGroupBooking ? a.staff.length : null,
        // Full participant IDs for compliance/audit traceability
        group_client_ids: isGroupBooking
          ? a.clients.map(function(c){ return c.contact_id || c; })
          : null,
        group_staff_ids: isGroupBooking
          ? a.staff.map(function(s){ return s.staff_id || s; })
          : null,
        group_primary_contact_id: isGroupBooking
          ? (a.clients.find(function(c){ return c.is_primary; }) || a.clients[0] || {}).contact_id || null
          : null
      }
    });

    // Send confirmation emails (new appointments only, matches existing solo
    // behavior). Skipped on edits to avoid spam. Non-blocking; failures logged
    // but don't break the booking response.
    if (isNew) {
      try {
        // Build recipients list. For group bookings, fetch all client emails
        // from contacts. For solo bookings, fetch the primary contact only.
        const contactIds = isGroupBooking
          ? a.clients.map(function(c){ return c.contact_id || c; })
          : (a.contactId ? [a.contactId] : []);

        if (contactIds.length) {
          const contactRows = await Promise.all(
            contactIds.map(function(cid){ return contactsLib.getContactById(subaccountId, cid); })
          );
          const recipients = contactRows
            .filter(Boolean)
            .map(function(c){
              return { contact_id: c.id, name: c.name || c.display_name || '', email: c.email || null };
            });

          // Service name: from services table
          let serviceName = a.title;
          if (a.service_id) {
            const svcRes = await db.query('SELECT name FROM services WHERE id=$1', [a.service_id]);
            if (svcRes.rows.length) serviceName = svcRes.rows[0].name;
          }

          // Staff name for solo bookings only
          let staffName = '';
          if (!isGroupBooking && a.assignedTo) {
            const stRes = await db.query(
              'SELECT display_name, username FROM subaccount_users WHERE id=$1',
              [a.assignedTo]
            );
            if (stRes.rows.length) {
              staffName = stRes.rows[0].display_name || stRes.rows[0].username || '';
            }
          }

          // Slug + business name from subaccounts. Business name comes from
          // settings JSONB (key business_name or businessName), falling back
          // to the subaccount's name column or 'MySpark+'.
          const subRes = await db.query(
            'SELECT slug, name, settings FROM subaccounts WHERE id=$1',
            [subaccountId]
          );
          const subRow = subRes.rows[0] || null;
          const slug = subRow ? subRow.slug : null;
          const settings = subRow && subRow.settings
            ? (typeof subRow.settings === 'string' ? JSON.parse(subRow.settings) : subRow.settings)
            : {};
          const businessName = (settings && (settings.business_name || settings.businessName))
            || (subRow && subRow.name)
            || 'MySpark+';

          if (slug) {
            await sendAppointmentConfirmations({
              subaccountId,
              subaccountSlug: slug,
              appointmentTitle: serviceName || a.title,
              appointmentDate: a.date,
              appointmentTime: a.time,
              location: a.location,
              recipients,
              staffName,
              businessName
            });
          }
        }
      } catch (emailErr) {
        console.warn('appointment confirmation email failed (non-fatal):', emailErr.message);
      }
    }

    // Fire automation trigger (fire-and-forget)
    try {
      const _contactIdFire = (existing.rows[0] && existing.rows[0].contact_id) || a.contact_id || a.contactId;
      if (isNew && _contactIdFire) {
        let _isFirstBook = false;
        try {
          const cR = await db.query(
            'SELECT COUNT(*) AS c FROM appointments WHERE subaccount_id = $1 AND contact_id = $2',
            [subaccountId, _contactIdFire]
          );
          _isFirstBook = parseInt(cR.rows[0].c, 10) === 1;
        } catch (cErr) {
          console.warn('isFirstBooking count failed:', cErr.message);
        }
        automations.fireAutomationTriggersAsync('appointment_booked', {
          subaccountId,
          contactId: _contactIdFire,
          appointmentId: a.id,
          serviceId: a.service_id || null,
          isFirstBooking: _isFirstBook,
          appointmentDate: a.date || null,
          appointmentStatus: a.status || ''
        });
      } else if (!isNew && _contactIdFire) {
        const _oldStatus = existing.rows[0].status;
        const _newStatus = a.status;
        if (_oldStatus !== _newStatus && _newStatus) {
          automations.fireAutomationTriggersAsync('appointment_status_changed', {
            subaccountId,
            contactId: _contactIdFire,
            appointmentId: a.id,
            oldStatus: _oldStatus,
            newStatus: _newStatus
          });
        }
      }
    } catch (autoErr) {
      console.error('Automation trigger fire error (non-fatal):', autoErr.message);
    }

    return res.status(200).json({ success: true, id: a.id });
  } catch (e) {
    console.error('appointments-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save appointment' });
  }
}

exports.handler = wrap(handler);
