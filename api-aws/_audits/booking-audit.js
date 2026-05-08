const db = require('./lib/db');

exports.handler = async function () {
  const out = { generated_at: new Date().toISOString(), sections: {} };

  try {
    const cols = await db.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'service_widgets' AND table_schema = 'public'
      ORDER BY ordinal_position
    `);
    out.sections.service_widgets_columns = cols.rows;
    const colNames = cols.rows.map(r => r.column_name);
    out.sections.has_widget_type = colNames.includes('widget_type');
    out.sections.has_staff_mode = colNames.includes('staff_mode');
    out.sections.has_appointment_types = colNames.includes('appointment_types');
    out.sections.has_round_robin_config = colNames.includes('round_robin_config');
    out.sections.has_require_payment = colNames.includes('require_payment');

    const total = await db.query(`SELECT COUNT(*)::int AS n FROM service_widgets`);
    out.sections.widget_count = total.rows[0].n;

    if (total.rows[0].n > 0) {
      const widgets = await db.query(`SELECT * FROM service_widgets ORDER BY created_at DESC LIMIT 20`);
      out.sections.widget_rows = widgets.rows.map(r => {
        const o = {};
        for (const k of Object.keys(r)) {
          const v = r[k];
          if (typeof v === 'object' && v !== null) {
            o[k] = JSON.stringify(v).length > 200 ? '...JSON ' + JSON.stringify(v).length + ' chars' : v;
          } else { o[k] = v; }
        }
        return o;
      });
      out.sections.sample_widget_full = widgets.rows[0];
    }

    const tables = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%widget%' OR table_name ILIKE '%booking%'
             OR table_name = 'appointments' OR table_name = 'services'
             OR table_name = 'class_participants' OR table_name = 'class_sessions')
      ORDER BY table_name
    `);
    out.sections.related_tables = tables.rows.map(r => r.table_name);

    if (total.rows[0].n > 0) {
      const services = await db.query(`
        SELECT type, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE active) AS active_count
        FROM services GROUP BY type ORDER BY count DESC
      `);
      out.sections.services_breakdown = services.rows;
    }

    const apptCols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'appointments' AND table_schema = 'public'
    `);
    const apptColNames = apptCols.rows.map(r => r.column_name);
    out.sections.appointments_columns_count = apptColNames.length;
    out.sections.has_booked_via = apptColNames.includes('booked_via');
    out.sections.has_widget_id = apptColNames.includes('widget_id');

    return { statusCode: 200, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    out.error = e.message;
    out.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(out, null, 2) };
  }
};
