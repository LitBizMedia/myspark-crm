// Adds Stage 2-5 widget config columns to service_widgets table,
// plus traceability columns to appointments table.
// Idempotent via ADD COLUMN IF NOT EXISTS.

const db = require('./lib/db');

const SERVICE_WIDGETS_COLS = [
  ['payment_mode',             "TEXT NOT NULL DEFAULT 'full' CHECK (payment_mode IN ('full','deposit','none'))"],
  ['deposit_type',             "TEXT CHECK (deposit_type IN ('flat','percent'))"],
  ['deposit_value',            'NUMERIC(10,2)'],
  ['allow_coupons',            'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['allow_tip',                'BOOLEAN NOT NULL DEFAULT FALSE'],
  ['tip_percentages',          "JSONB NOT NULL DEFAULT '[10,15,20]'::jsonb"],
  ['collect_phone',            'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['collect_notes',            'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['require_existing_patient', 'BOOLEAN NOT NULL DEFAULT FALSE'],
  ['allow_self_cancel',        'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['cancel_window_hours',      'INTEGER NOT NULL DEFAULT 24'],
  ['send_confirmation_email',  'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['send_reminder_email',      'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['reminder_hours_before',    'INTEGER NOT NULL DEFAULT 24'],
  ['send_reminder_sms',        'BOOLEAN NOT NULL DEFAULT FALSE'],
  ['booking_lead_time_hours',  'INTEGER'],
  ['booking_advance_days',     'INTEGER'],
  ['buffer_before_override',   'INTEGER'],
  ['buffer_after_override',    'INTEGER'],
  ['total_views',              'INTEGER NOT NULL DEFAULT 0'],
  ['total_bookings',           'INTEGER NOT NULL DEFAULT 0'],
  ['custom_domain',            'TEXT']
];

const APPOINTMENTS_COLS = [
  ['booked_via', 'TEXT'],
  ['widget_id',  'TEXT']
];

exports.handler = async function () {
  const log = [];
  try {
    log.push('=== service_widgets ===');
    for (const [name, def] of SERVICE_WIDGETS_COLS) {
      try {
        await db.query(`ALTER TABLE service_widgets ADD COLUMN IF NOT EXISTS ${name} ${def}`);
        log.push(`  ok ${name}`);
      } catch (e) {
        log.push(`  FAIL ${name}: ${e.message}`);
      }
    }

    log.push('=== appointments ===');
    for (const [name, def] of APPOINTMENTS_COLS) {
      try {
        await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ${name} ${def}`);
        log.push(`  ok ${name}`);
      } catch (e) {
        log.push(`  FAIL ${name}: ${e.message}`);
      }
    }

    log.push('=== verify service_widgets columns added ===');
    const sw = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='service_widgets' AND table_schema='public'
        AND column_name = ANY($1)
      ORDER BY column_name
    `, [SERVICE_WIDGETS_COLS.map(c => c[0])]);
    log.push(`  found ${sw.rows.length}/${SERVICE_WIDGETS_COLS.length}: ${sw.rows.map(r => r.column_name).join(', ')}`);

    log.push('=== verify appointments columns added ===');
    const ap = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='appointments' AND table_schema='public'
        AND column_name = ANY($1)
      ORDER BY column_name
    `, [APPOINTMENTS_COLS.map(c => c[0])]);
    log.push(`  found ${ap.rows.length}/${APPOINTMENTS_COLS.length}: ${ap.rows.map(r => r.column_name).join(', ')}`);

    return { statusCode: 200, body: JSON.stringify({ success: true, log }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, log }) };
  }
};
