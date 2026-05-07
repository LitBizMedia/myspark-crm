const db = require('./lib/db');

exports.handler = async function () {
  try {
    // Find what we're about to delete (for the audit trail in this Lambda's response)
    const preview = await db.query(`
      SELECT id, subaccount_id, appointment_id, subtotal, total, status, created_at
        FROM payments
       WHERE payment_method = 'none'
       ORDER BY created_at DESC
    `);

    const result = await db.query(`
      DELETE FROM payments
       WHERE payment_method = 'none'
    `);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        deleted_count: result.rowCount,
        deleted_records: preview.rows
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
