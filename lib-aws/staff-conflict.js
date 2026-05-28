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
    bufferBefore,                // optional: buffer (minutes) before the incoming appt
    bufferAfter,                 // optional: buffer (minutes) after the incoming appt
    dbClient
  } = opts;

  if (!staffId || !subaccountId || !date || !time || !duration) {
    return { ok: true };
  }

  const dur = parseInt(duration) || 60;
  const statusClause = statusFilter || "status != 'cancelled'";
  const ignoreId = ignoreAppointmentId || '';
  // Buffer-aware overlap: pad BOTH the incoming appointment and each existing
  // appointment by their before/after buffers. Two appointments conflict when
  // their buffer-padded windows intersect, even if raw service times don't.
  // Buffers default to 0 when not provided (backward compatible: behaves like
  // the old raw-overlap check when no buffers exist).
  const newBufBefore = parseInt(bufferBefore) || 0;
  const newBufAfter = parseInt(bufferAfter) || 0;

  try {
    // Window math (minutes-from-midnight via ::time + interval):
    //   incoming:  [ $5 - newBufBefore , $5 + dur + newBufAfter )
    //   existing:  [ time - buffer_before , time + duration + buffer_after )
    // Conflict when incoming.start < existing.end AND incoming.end > existing.start.
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
          ($5::time - ($7 || ' minutes')::interval)
            < (time::time + ((COALESCE(duration,60) + COALESCE(buffer_after,0)) || ' minutes')::interval)
          AND
          ($5::time + (($6::int + $8::int) || ' minutes')::interval)
            > (time::time - (COALESCE(buffer_before,0) || ' minutes')::interval)
        )
      LIMIT 1
    `, [subaccountId, staffId, date, ignoreId, time, String(dur), String(newBufBefore), String(newBufAfter)]);

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
