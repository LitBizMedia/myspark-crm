// Reschedule an existing appointment.
//
// Creates a NEW appointment row with status='scheduled' and rescheduled_from_id
// pointing at the original. Marks the original as status='rescheduled' (slot abandoned).
// Migrates payment record (per Payment Policy carve-out for reschedule). Clones
// appointment_clients, appointment_staff, appointment_resources for group bookings.
// Sends an "Appointment Rescheduled" email with old + new dates.
//
// POST body: {
//   original_appointment_id: string (required),
//   new_date: 'YYYY-MM-DD' (required),
//   new_time: 'HH:MM' (required),
//   new_duration: int (optional, defaults to original.duration),
//   new_notes: string (optional, defaults to original.notes),
//   override: bool (optional, skips conflict check)
// }

const db = require('./lib/db');
const contactsLib = require('./lib/contacts');
const { sendAppointmentConfirmations } = require('./lib/appointment-emails');
const { checkStaffConflict } = require('./lib/staff-conflict');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isTerminalStatus } = require('./lib/appt-statuses');
const { wrap } = require('./lib/lambda-adapter');
const { appointmentToFrontend } = require('./lib/appointments');

function newId() {
  return 'appt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  const subaccountId = auth.subaccount_id;

  const body = req.body || {};
  const originalId = body.original_appointment_id;
  const newDate = body.new_date;
  const newTime = body.new_time;

  if (!originalId || !newDate || !newTime) {
    return res.status(400).json({ error: 'original_appointment_id, new_date, and new_time are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return res.status(400).json({ error: 'new_date must be YYYY-MM-DD' });
  }
  if (!/^\d{2}:\d{2}$/.test(newTime)) {
    return res.status(400).json({ error: 'new_time must be HH:MM' });
  }

  try {
    // Lookup original appointment, verify ownership
    const origRes = await db.query(
      `SELECT * FROM appointments WHERE id = $1 AND subaccount_id = $2`,
      [originalId, subaccountId]
    );
    if (!origRes.rows.length) {
      return res.status(404).json({ error: 'Original appointment not found' });
    }
    const orig = origRes.rows[0];

    // Reject if already terminal
    if (isTerminalStatus(orig.status)) {
      return res.status(400).json({
        error: 'Cannot reschedule an appointment with status: ' + orig.status
      });
    }

    // Detect group booking (presence of rows in appointment_clients OR appointment_staff)
    const groupClientsRes = await db.query(
      `SELECT contact_id, is_primary FROM appointment_clients WHERE appointment_id = $1`,
      [originalId]
    );
    const groupStaffRes = await db.query(
      `SELECT staff_id, display_order FROM appointment_staff WHERE appointment_id = $1`,
      [originalId]
    );
    const groupResourcesRes = await db.query(
      `SELECT resource_id, group_id FROM appointment_resources WHERE appointment_id = $1`,
      [originalId]
    );
    const isGroupBooking = groupClientsRes.rows.length > 0 || groupStaffRes.rows.length > 1;

    const newDuration = body.new_duration != null ? parseInt(body.new_duration) : (orig.duration || 60);
    const newNotes = body.new_notes != null ? body.new_notes : orig.notes;

    // SLICE 4: optional staff reassignment.
    // body.new_staff_id, when present and valid, becomes the new appointment's
    // assigned_to. Falls back to orig.assigned_to when missing or invalid.
    // Group bookings (multi-staff) intentionally ignore new_staff_id; staff
    // reassignment on group appointments is out of scope.
    let effectiveStaffId = orig.assigned_to;
    if (body.new_staff_id && !isGroupBooking) {
      try {
        const staffRes = await db.query(
          'SELECT id FROM subaccount_users WHERE id = $1::uuid AND subaccount_id = $2 AND active = true',
          [body.new_staff_id, subaccountId]
        );
        if (staffRes.rows.length) {
          effectiveStaffId = body.new_staff_id;
        } else {
          console.warn('appointments-reschedule: new_staff_id not found or inactive, ignoring:', body.new_staff_id);
        }
      } catch (staffErr) {
        console.warn('appointments-reschedule: new_staff_id validation failed:', staffErr.message);
      }
    }

    // Conflict check on new slot (skip if override=true). Uses the same isActive
    // filter as appointments-upsert; cancelled/no-show/completed/rescheduled
    // appointments do NOT block.
    if (effectiveStaffId && !body.override) {
      try {
        const result = await checkStaffConflict({
          staffId: effectiveStaffId,
          subaccountId,
          date: newDate,
          time: newTime,
          duration: newDuration,
          ignoreAppointmentId: originalId,
          statusFilter: "status NOT IN ('completed','cancelled','no-show','rescheduled')",
          dbClient: db
        });
        if (!result.ok) {
          return res.status(409).json({ error: 'conflict', conflict: result.conflict });
        }
      } catch (conflictErr) {
        console.warn('appointments-reschedule: conflict check skipped due to error:', conflictErr.message);
      }
    }

    // Group conflict check
    if (isGroupBooking && !body.override) {
      for (const sRow of groupStaffRes.rows) {
        try {
          const r = await checkStaffConflict({
            staffId: sRow.staff_id,
            subaccountId,
            date: newDate,
            time: newTime,
            duration: newDuration,
            ignoreAppointmentId: originalId,
            statusFilter: "status NOT IN ('completed','cancelled','no-show','rescheduled')",
            dbClient: db
          });
          if (!r.ok) {
            return res.status(409).json({
              error: 'group_staff_conflict',
              conflict_staff_id: sRow.staff_id,
              conflict: r.conflict
            });
          }
        } catch (cErr) {
          console.warn('group reschedule conflict skipped:', cErr.message);
        }
      }
    }

    // Mint new appointment ID
    const newApptId = newId();

    // Insert new row, copying all relevant fields from original
    await db.query(`
      INSERT INTO appointments (
        id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
        status, location, notes, service_id, service_variation_id, addons,
        buffer_before, buffer_after, appointment_type_id, booked_via, widget_id,
        price, rescheduled_from_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, NOW(), NOW())
    `, [
      newApptId, subaccountId, orig.title, orig.contact_id, effectiveStaffId,
      newDate, newTime, newDuration,
      orig.location, newNotes, orig.service_id, orig.service_variation_id,
      JSON.stringify(orig.addons || []),
      orig.buffer_before || 0, orig.buffer_after || 0,
      orig.appointment_type_id, orig.booked_via, orig.widget_id,
      orig.price, originalId
    ]);

    // Clone group rows
    if (groupClientsRes.rows.length) {
      for (const cRow of groupClientsRes.rows) {
        await db.query(
          `INSERT INTO appointment_clients (appointment_id, contact_id, is_primary, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [newApptId, cRow.contact_id, cRow.is_primary]
        );
      }
    }
    if (groupStaffRes.rows.length) {
      for (const sRow of groupStaffRes.rows) {
        await db.query(
          `INSERT INTO appointment_staff (appointment_id, staff_id, display_order, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [newApptId, sRow.staff_id, sRow.display_order]
        );
      }
    }
    if (groupResourcesRes.rows.length) {
      for (const rRow of groupResourcesRes.rows) {
        await db.query(
          `INSERT INTO appointment_resources (appointment_id, resource_id, group_id)
           VALUES ($1, $2, $3)`,
          [newApptId, rRow.resource_id, rRow.group_id]
        );
      }
    }

    // Migrate payments. Per Payment Policy carve-out: reschedule moves the payment
    // link from the original to the new appointment because the patient already
    // paid for THIS service, just at a different time.
    const paymentRes = await db.query(
      `UPDATE payments SET appointment_id = $1
       WHERE appointment_id = $2 AND subaccount_id = $3
       RETURNING id`,
      [newApptId, originalId, subaccountId]
    );
    const paymentsMigrated = paymentRes.rows.length;

    // Mark original as rescheduled
    await db.query(
      `UPDATE appointments SET status = 'rescheduled', updated_at = NOW()
       WHERE id = $1 AND subaccount_id = $2`,
      [originalId, subaccountId]
    );

    // Audit log
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.appointment.reschedule',
      targetType: 'appointment',
      targetId: newApptId,
      targetSubaccountId: subaccountId,
      metadata: {
        original_id: originalId,
        new_id: newApptId,
        old_date: orig.date,
        old_time: orig.time,
        new_date: newDate,
        new_time: newTime,
        group_booking: isGroupBooking,
        group_client_count: groupClientsRes.rows.length,
        group_staff_count: groupStaffRes.rows.length,
        payments_migrated: paymentsMigrated,
        override: !!body.override
      }
    });

    // Send "Appointment Rescheduled" email (non-blocking, mirrors upsert pattern)
    try {
      const contactIds = isGroupBooking
        ? groupClientsRes.rows.map(function(c){ return c.contact_id; })
        : (orig.contact_id ? [orig.contact_id] : []);

      if (contactIds.length) {
        const contactRows = await Promise.all(
          contactIds.map(function(cid){ return contactsLib.getContactById(subaccountId, cid); })
        );
        const recipients = contactRows.filter(Boolean).map(function(c){
          return { contact_id: c.id, name: c.name || c.display_name || '', email: c.email || null };
        });

        let serviceName = orig.title;
        if (orig.service_id) {
          const svcRes = await db.query('SELECT name FROM services WHERE id=$1', [orig.service_id]);
          if (svcRes.rows.length) serviceName = svcRes.rows[0].name;
        }

        let staffName = '';
        if (!isGroupBooking && effectiveStaffId) {
          const stRes = await db.query(
            `SELECT display_name, username FROM subaccount_users WHERE id = $1::uuid`,
            [effectiveStaffId]
          );
          if (stRes.rows.length) {
            staffName = stRes.rows[0].display_name || stRes.rows[0].username || '';
          }
        }

        const subRes = await db.query(
          `SELECT slug, name FROM subaccounts WHERE id = $1`,
          [subaccountId]
        );
        const slug = subRes.rows[0] ? subRes.rows[0].slug : '';
        const businessName = subRes.rows[0] ? subRes.rows[0].name : '';

        if (recipients.length && slug) {
          const subject = 'Appointment Rescheduled: ' + serviceName + ' moved to ' +
            newDate + (newTime ? ' at ' + newTime : '');
          await sendAppointmentConfirmations({
            subaccountId,
            subaccountSlug: slug,
            appointmentTitle: serviceName || orig.title,
            appointmentDate: newDate,
            appointmentTime: newTime,
            location: orig.location,
            recipients,
            staffName,
            businessName,
            subjectOverride: subject,
            oldDate: orig.date,
            oldTime: orig.time,
            templateTypeOverride: 'appt-rescheduled'
          });
        }
      }
    } catch (emailErr) {
      console.warn('appointment reschedule email failed (non-fatal):', emailErr.message);
    }

    // Fetch the newly created appointment so the frontend can render
    // immediately without waiting on RDS Proxy read-replica catch-up.
    let newAppointment = null;
    try {
      const newRes = await db.query(
        'SELECT * FROM appointments WHERE id = $1 AND subaccount_id = $2',
        [newApptId, subaccountId]
      );
      if (newRes.rows.length) {
        newAppointment = appointmentToFrontend(newRes.rows[0]);
      }
    } catch (selErr) {
      console.warn('appointments-reschedule: post-insert SELECT failed (non-fatal):', selErr.message);
    }

    return res.status(200).json({
      success: true,
      appointment_id: newApptId,
      original_id: originalId,
      payments_migrated: paymentsMigrated,
      new_appointment: newAppointment
    });
  } catch (e) {
    console.error('appointments-reschedule error:', e.message);
    return res.status(500).json({ error: 'Failed to reschedule appointment' });
  }
}

exports.handler = wrap(handler);
