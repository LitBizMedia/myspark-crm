// Restore groups schema. Drops flat service_resources, recreates groups tables.
// See sql/2026-05-08-resources-groups-restore.sql
const db = require('./lib/db');

exports.handler = async () => {
  try {
    await db.query(`DROP TABLE IF EXISTS service_resources CASCADE`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS service_resource_groups (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        subaccount_id TEXT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_srg_service ON service_resource_groups(service_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_srg_subaccount ON service_resource_groups(subaccount_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS service_resource_group_members (
        group_id TEXT NOT NULL REFERENCES service_resource_groups(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        display_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, resource_id)
      )
    `);

    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM service_resource_groups) AS groups,
        (SELECT COUNT(*) FROM service_resource_group_members) AS members
    `);
    return { ok: true, counts: counts.rows[0] };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};
