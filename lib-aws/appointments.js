// =====================================================
// lib-aws/appointments.js
// =====================================================
// Canonical accessor for appointments. As of May 27, 2026:
//   - appointmentToFrontend: maps a single appointments row from RDS
//     (snake_case Postgres) to the camelCase/mixed shape the frontend expects.
//     Single source of truth for that shape. Any Lambda that returns an
//     appointment to the frontend should import and use this.
//
// Field naming is intentionally mixed:
//   - assignedTo, contactId, createdAt, updatedAt: camelCase (legacy blob shape)
//   - service_id, buffer_before, rescheduled_from_id, etc.: snake_case
//   This matches what the frontend already reads. Do not "normalize" it
//   without coordinated frontend changes.
//
// Future helpers to land here as multi-Lambda usage emerges:
//   - group booking client+staff bucketing
//   - appointment_clients / appointment_staff / appointment_resources helpers

function appointmentToFrontend(row) {
  if (!row) return row;
  // Normalize date column (Postgres DATE comes back as a JS Date)
  let dateStr = row.date;
  if (row.date instanceof Date) {
    // Use UTC to avoid timezone drift
    const y = row.date.getUTCFullYear();
    const m = String(row.date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(row.date.getUTCDate()).padStart(2, '0');
    dateStr = y + '-' + m + '-' + d;
  } else if (typeof row.date === 'string' && row.date.length > 10) {
    // ISO-like string; truncate to YYYY-MM-DD
    dateStr = row.date.slice(0, 10);
  }

  return {
    id: row.id,
    title: row.title,
    contactId: row.contact_id,
    assignedTo: row.assigned_to,
    date: dateStr,
    time: row.time,
    duration: row.duration,
    status: row.status,
    location: row.location,
    notes: row.notes,
    buffer_before: row.buffer_before,
    buffer_after: row.buffer_after,
    service_id: row.service_id,
    service_variation_id: row.service_variation_id || null,
    price: row.price != null ? parseFloat(row.price) : null,
    appointment_type_id: row.appointment_type_id || null,
    booked_via: row.booked_via || null,
    widget_id: row.widget_id || null,
    addons: Array.isArray(row.addons) ? row.addons : (row.addons ? row.addons : []),
    rescheduled_from_id: row.rescheduled_from_id || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

module.exports = {
  appointmentToFrontend
};
