// api-aws/_migrations/appointment-reminders-table.js
//
// One-shot migration: create appointment_reminders table with the
// unique constraint cron-reminders.js needs for ON CONFLICT idempotency.
//
// WHY: cron-reminders has been firing the same emails hourly because
// logReminder() fails silently when the table or constraint is missing,
// breaking reminderAlreadySent() on the next run.
//
// Idempotent. Safe to run multiple times.

const db = require('./lib/db');

async function migrate() {
  const log = [];

  // Step 1: does the table exist?
  const tableCheck = await db.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
    + "WHERE table_schema = 'public' AND table_name = 'appointment_reminders') AS exists"
  );
  const exists = tableCheck.rows[0].exists;
  log.push('Table exists before: ' + exists);

  if (!exists) {
    await db.query(
      "CREATE TABLE appointment_reminders ("
      + "id SERIAL PRIMARY KEY,"
      + "subaccount_id TEXT NOT NULL,"
      + "appointment_id TEXT NOT NULL,"
      + "reminder_type TEXT NOT NULL,"
      + "email_sent BOOLEAN NOT NULL DEFAULT FALSE,"
      + "sms_sent BOOLEAN NOT NULL DEFAULT FALSE,"
      + "sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
      + "CONSTRAINT appointment_reminders_unique "
      + "UNIQUE (subaccount_id, appointment_id, reminder_type))"
    );
    await db.query(
      "CREATE INDEX idx_appointment_reminders_lookup "
      + "ON appointment_reminders (subaccount_id, appointment_id, reminder_type)"
    );
    log.push('Created table + unique constraint + index');
  } else {
    const cons = await db.query(
      "SELECT con.conname, pg_get_constraintdef(con.oid) AS def "
      + "FROM pg_constraint con "
      + "JOIN pg_class rel ON rel.oid = con.conrelid "
      + "WHERE rel.relname = 'appointment_reminders' AND con.contype = 'u'"
    );
    log.push('Existing unique constraints: ' + JSON.stringify(cons.rows));

    const hasIt = cons.rows.some(function (r) {
      const d = r.def || '';
      return d.indexOf('subaccount_id') >= 0
          && d.indexOf('appointment_id') >= 0
          && d.indexOf('reminder_type') >= 0;
    });

    if (!hasIt) {
      const dupResult = await db.query(
        "DELETE FROM appointment_reminders WHERE id NOT IN ("
        + "SELECT MIN(id) FROM appointment_reminders "
        + "GROUP BY subaccount_id, appointment_id, reminder_type)"
      );
      log.push('Dedupe removed rows: ' + dupResult.rowCount);

      await db.query(
        "ALTER TABLE appointment_reminders "
        + "ADD CONSTRAINT appointment_reminders_unique "
        + "UNIQUE (subaccount_id, appointment_id, reminder_type)"
      );
      log.push('Added unique constraint');
    } else {
      log.push('Unique constraint already present, no change');
    }
  }

  const finalCols = await db.query(
    "SELECT column_name, data_type, is_nullable "
    + "FROM information_schema.columns "
    + "WHERE table_schema = 'public' AND table_name = 'appointment_reminders' "
    + "ORDER BY ordinal_position"
  );
  log.push('Final columns: ' + JSON.stringify(finalCols.rows));

  const rc = await db.query("SELECT COUNT(*) AS n FROM appointment_reminders");
  log.push('Row count: ' + rc.rows[0].n);

  return { success: true, log: log };
}

exports.handler = async function () {
  try {
    const result = await migrate();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    console.error('Migration error:', e.stack || e.message);
    return { success: false, error: e.message };
  }
};
