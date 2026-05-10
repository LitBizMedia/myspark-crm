// One-time migration: add group booking columns + tables.
// See sql/2026-05-10-group-booking.sql
const db = require('./lib/db');

exports.handler = async () => {
  try {
    // Services columns
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_capable BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_staff_count INT`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_eligible_staff JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_size_min INT`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_size_max INT`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_price NUMERIC(10,2)`);
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS group_resource_mode TEXT CHECK (group_resource_mode IN ('capacity', 'separate') OR group_resource_mode IS NULL)`);

    // appointment_clients
    await db.query(`
      CREATE TABLE IF NOT EXISTS appointment_clients (
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (appointment_id, contact_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_apptclients_appt ON appointment_clients(appointment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_apptclients_contact ON appointment_clients(contact_id)`);

    // appointment_staff
    await db.query(`
      CREATE TABLE IF NOT EXISTS appointment_staff (
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        staff_id TEXT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (appointment_id, staff_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_apptstaff_appt ON appointment_staff(appointment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_apptstaff_staff ON appointment_staff(staff_id)`);

    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM appointment_clients) AS clients,
        (SELECT COUNT(*) FROM appointment_staff) AS staff,
        (SELECT COUNT(*) FROM services WHERE group_capable = TRUE) AS group_services
    `);
    return { ok: true, counts: counts.rows[0] };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};
