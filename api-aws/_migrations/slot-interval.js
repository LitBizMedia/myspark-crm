const db = require('./lib/db');
exports.handler = async function () {
  const log = [];
  try {
    await db.query(`ALTER TABLE service_widgets ADD COLUMN IF NOT EXISTS slot_interval_minutes INTEGER`);
    log.push('  ok added slot_interval_minutes');

    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_widgets_slot_interval_check') THEN
          ALTER TABLE service_widgets
            ADD CONSTRAINT service_widgets_slot_interval_check
            CHECK (slot_interval_minutes IS NULL OR slot_interval_minutes IN (10, 15, 30, 60));
        END IF;
      END $$;
    `);
    log.push('  ok added CHECK constraint');

    const v = await db.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='service_widgets' AND column_name='slot_interval_minutes'
    `);
    log.push('  verify: ' + JSON.stringify(v.rows[0]));

    return { statusCode: 200, body: JSON.stringify({ success: true, log }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, log }) };
  }
};
