const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const cols = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='plan_pricing' AND table_schema='public' ORDER BY ordinal_position`);
    const rows = await db.query('SELECT * FROM plan_pricing LIMIT 10');
    return res.status(200).json({ columns: cols.rows, rows: rows.rows });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
