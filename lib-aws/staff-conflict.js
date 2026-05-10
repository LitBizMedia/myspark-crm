// Shared helper: detects time-overlap conflicts for a staff member's bookings.
// Single source of truth for the overlap query used by appointments-upsert,
// booking-submit, and booking-reschedule.

// Overlap rule: two appointments conflict when their time + duration windows
// intersect on the same staff/date. The query handles three cases:
//   1. New appt starts during existing one
//   2. New appt ends during existing one
//   3. New appt fully contains existing one

// Returns:
//   { ok: true } if no conflict
//   { ok: false, conflict: {id, title, time, duration} } when blocked

async function checkStaffConflict(opts) {
  const {
    staffId,
    subaccountId,
    date,
    time,
    duration,
    ignoreAppointmentId,        // null for new bookings; appt id for edits/reschedules
    statusFilter,                // default: "!= 'cancelled'"; pass "= 'scheduled'" for stricter
    dbClient
  } = opts;

  if (!staffId || !subaccountId || !date || !time || !duration) {
    return { ok: true };
  }

  const dur = parseInt(duration) || 60;
  const statusClause = statusFilter || "status != 'cancelled'";
  const ignoreId = ignoreAppointmentId || '';

  try {
    const r = await dbClient.query(`
      SELECT id, title, time, duration
      FROM appointments
      WHERE subaccount_id = $1
        AND assigned_to = $2
        AND date = $3
        AND ${statusClause}
        AND ($4::text = '' OR id != $4)
        AND time IS NOT NULL
        AND (
          ($5::time >= time::time AND $5::time < (time::time + (duration || ' minutes')::interval))
          OR
          (($5::time + ($6 || ' minutes')::interval) > time::time AND $5::time < time::time)
          OR
          ($5::time <= time::time AND ($5::time + ($6 || ' minutes')::interval) >= (time::time + (duration || ' minutes')::interval))
        )
      LIMIT 1
    `, [subaccountId, staffId, date, ignoreId, time, String(dur)]);

    if (r.rows.length === 0) return { ok: true };

    const c = r.rows[0];
    return {
      ok: false,
      conflict: {
        id: c.id,
        title: c.title,
        time: typeof c.time === 'string' ? c.time : (c.time && c.time.toString().slice(0, 5)),
        duration: c.duration
      }
    };
  } catch (e) {
    // Caller decides whether to log the warning. Return ok so save proceeds
    // (frontend has its own conflict UI; soft-fail beats blocking legit saves).
    throw e;
  }
}

module.exports = { checkStaffConflict };
