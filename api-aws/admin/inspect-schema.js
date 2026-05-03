const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const sub = await db.query("SELECT id FROM subaccounts WHERE slug='renametest'");
    const data = await db.query("SELECT subaccount_id FROM subaccount_data WHERE subaccount_id='sub-renametest'");
    const plans = await db.query("SELECT subaccount_id FROM subaccount_plans WHERE subaccount_id='sub-renametest'");
    const users = await db.query("SELECT id FROM subaccount_users WHERE subaccount_id='sub-renametest'");
    return res.status(200).json({ sub:sub.rows.length, data:data.rows.length, plans:plans.rows.length, users:users.rows.length });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
