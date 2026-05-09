// One-time migration: drop group tables, create service_resources join.
// See sql/2026-05-08-resources-simplify.sql
const db = require('./lib/db');

exports.handler = async () => {
  try {
    await db.query(`DROP TABLE IF EXISTS service_resource_group_members CASCADE`);
    await db.query(`DROP TABLE IF EXISTS service_resource_groups CASCADE`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS service_resources (
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        subaccount_id TEXT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, resource_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sr_service ON service_resources(service_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sr_resource ON service_resources(resource_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sr_subaccount ON service_resources(subaccount_id)`);

    const counts = await db.query(`SELECT COUNT(*) AS service_resources FROM service_resources`);
    return { ok: true, counts: counts.rows[0] };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};
