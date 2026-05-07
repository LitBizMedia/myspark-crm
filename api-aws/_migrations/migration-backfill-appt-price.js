const db = require('./lib/db');

exports.handler = async function () {
  try {
    // Find all widget-booked appointments missing a price.
    const apptsRes = await db.query(`
      SELECT id, widget_id, appointment_type_id, title
        FROM appointments
       WHERE booked_via = 'widget'
         AND price IS NULL
         AND service_id IS NULL
    `);

    if (apptsRes.rows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, found: 0, updated: 0 }, null, 2) };
    }

    // Pre-load every relevant widget once.
    const widgetIds = [...new Set(apptsRes.rows.map(r => r.widget_id).filter(Boolean))];
    const widgetsRes = await db.query(
      `SELECT id, name, appointment_types FROM service_widgets WHERE id = ANY($1)`,
      [widgetIds]
    );
    const widgetMap = {};
    for (const w of widgetsRes.rows) widgetMap[w.id] = w;

    const updates = [];
    let updated = 0;

    for (const a of apptsRes.rows) {
      const w = widgetMap[a.widget_id];
      if (!w) {
        updates.push({ id: a.id, status: 'skipped: widget not found' });
        continue;
      }

      const types = Array.isArray(w.appointment_types) ? w.appointment_types : [];
      let chosen = null;

      // Try by stored appointment_type_id first.
      if (a.appointment_type_id) {
        chosen = types.find(t => t && t.id === a.appointment_type_id);
      }
      // Fall back to title match.
      if (!chosen && a.title) {
        chosen = types.find(t => t && t.name === a.title);
      }
      // Fall back to single appointment_type if there's only one.
      if (!chosen && types.length === 1) {
        chosen = types[0];
      }

      if (!chosen || chosen.price == null) {
        updates.push({ id: a.id, title: a.title, widget: w.name, status: 'skipped: no matching appointment_type with price' });
        continue;
      }

      await db.query(
        `UPDATE appointments
            SET price = $1, appointment_type_id = $2, updated_at = NOW()
          WHERE id = $3`,
        [parseFloat(chosen.price), chosen.id, a.id]
      );
      updated++;
      updates.push({
        id: a.id,
        title: a.title,
        widget: w.name,
        status: 'updated',
        price: parseFloat(chosen.price),
        appointment_type_id: chosen.id
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, found: apptsRes.rows.length, updated, details: updates }, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
