const db = require('./lib/db');
exports.handler = async function () {
  try {
    const r = await db.query(
      `SELECT id, name, active, widget_type, payment_mode, allow_tip, allow_coupons,
              collect_phone, collect_notes, require_payment, updated_at
       FROM service_widgets
       WHERE id = 'mot1ex71iwv20ejgns8'`
    );
    return { statusCode: 200, body: JSON.stringify(r.rows[0] || { error: 'not found' }, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
