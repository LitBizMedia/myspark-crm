const db = require('./lib/db');

exports.handler = async function () {
  const out = {};
  const widgetId = 'mot1ex71iwv20ejgns8';

  try {
    // 1. Widget counters
    const w = await db.query(
      `SELECT id, name, total_views, total_bookings, updated_at
       FROM service_widgets WHERE id = $1`,
      [widgetId]
    );
    out.widget = w.rows[0] || null;

    // 2. Most recent appointments via widget
    const appts = await db.query(
      `SELECT id, title, contact_id, date, time, booked_via, widget_id, created_at
       FROM appointments
       WHERE booked_via = 'widget'
       ORDER BY created_at DESC
       LIMIT 5`
    );
    out.recent_widget_appointments = appts.rows;

    // 3. Class participants from widget (JSONB scan)
    const classes = await db.query(
      `SELECT cs.id, cs.title, cs.date,
              jsonb_array_length(cs.participants) AS participant_count,
              (SELECT array_agg(p->>'widget_id') FROM jsonb_array_elements(cs.participants) p
               WHERE p->>'widget_id' IS NOT NULL) AS widget_ids
       FROM class_sessions cs
       WHERE cs.participants @> '[{"source":"booking_widget"}]'::jsonb
       ORDER BY cs.date DESC
       LIMIT 5`
    );
    out.recent_widget_class_bookings = classes.rows;

    return { statusCode: 200, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
