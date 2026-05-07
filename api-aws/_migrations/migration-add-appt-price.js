const db = require('./lib/db');

exports.handler = async function () {
  try {
    await db.query(`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) NULL,
        ADD COLUMN IF NOT EXISTS appointment_type_id TEXT NULL
    `);

    // Sanity check
    const r = await db.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'appointments'
         AND column_name IN ('price', 'appointment_type_id')
       ORDER BY column_name
    `);

    return { statusCode: 200, body: JSON.stringify({ ok: true, columns: r.rows }, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
