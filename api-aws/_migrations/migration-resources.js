// One-time migration: create resources, service_resource_groups,
// service_resource_group_members, appointment_resources tables.
// See sql/2026-05-08-resources.sql for the canonical schema.
const db = require('./lib/db');

exports.handler = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        subaccount_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'room'
          CHECK (type IN ('room', 'equipment', 'other')),
        capacity INT NOT NULL DEFAULT 1,
        buffer_after INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        display_order INT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_resources_subaccount ON resources(subaccount_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS service_resource_groups (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        subaccount_id TEXT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_srg_service ON service_resource_groups(service_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_srg_subaccount ON service_resource_groups(subaccount_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS service_resource_group_members (
        group_id TEXT NOT NULL REFERENCES service_resource_groups(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, resource_id)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS appointment_resources (
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id),
        group_id TEXT,
        PRIMARY KEY (appointment_id, resource_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_apptres_resource ON appointment_resources(resource_id)`);

    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM resources) AS resources,
        (SELECT COUNT(*) FROM service_resource_groups) AS groups,
        (SELECT COUNT(*) FROM service_resource_group_members) AS members,
        (SELECT COUNT(*) FROM appointment_resources) AS claims
    `);
    return { ok: true, counts: counts.rows[0] };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};
