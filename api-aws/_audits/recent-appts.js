const db = require('./lib/db');
exports.handler = async function () {
  try {
    const r = await db.query(`
      SELECT id, title, price, appointment_type_id, service_id, service_variation_id,
             booked_via, widget_id, date, time, created_at
        FROM appointments
       WHERE booked_via = 'widget'
       ORDER BY created_at DESC
       LIMIT 5
    `);
    return { statusCode: 200, body: JSON.stringify(r.rows, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
