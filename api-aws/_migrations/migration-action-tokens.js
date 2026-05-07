const db = require('./lib/db');

exports.handler = async function () {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS booking_action_tokens (
        token TEXT PRIMARY KEY,
        appointment_id TEXT NOT NULL,
        subaccount_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('cancel', 'reschedule')),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_action_tokens_appt ON booking_action_tokens(appointment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_action_tokens_expires ON booking_action_tokens(expires_at) WHERE used_at IS NULL`);

    const r = await db.query(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = 'booking_action_tokens'
       ORDER BY column_name
    `);

    return { statusCode: 200, body: JSON.stringify({ ok: true, columns: r.rows }, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
