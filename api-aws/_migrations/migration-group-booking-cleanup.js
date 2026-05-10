// One-time migration: drop unused group booking columns now that the feature
// uses assigned_staff (instead of group_eligible_staff) and auto-detects
// resource mode (instead of group_resource_mode).
const db = require('./lib/db');

exports.handler = async () => {
  try {
    await db.query(`ALTER TABLE services DROP COLUMN IF EXISTS group_eligible_staff`);
    await db.query(`ALTER TABLE services DROP COLUMN IF EXISTS group_price`);
    await db.query(`ALTER TABLE services DROP COLUMN IF EXISTS group_resource_mode`);
    const remaining = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'services' AND column_name LIKE 'group_%'
      ORDER BY column_name
    `);
    return { ok: true, remaining_group_cols: remaining.rows.map(r => r.column_name) };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};
