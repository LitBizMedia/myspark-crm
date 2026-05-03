const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const sub = await db.query("SELECT * FROM subaccounts WHERE slug='cleanuptest'");
    const data = await db.query("SELECT subaccount_id FROM subaccount_data WHERE subaccount_id='sub-cleanuptest'");
    const plans = await db.query("SELECT subaccount_id FROM subaccount_plans WHERE subaccount_id='sub-cleanuptest'");
    const users = await db.query("SELECT id, username FROM subaccount_users WHERE subaccount_id='sub-cleanuptest'");
    return res.status(200).json({
      subaccount_rows: sub.rows.length,
      data_rows: data.rows.length,
      plan_rows: plans.rows.length,
      user_rows: users.rows.length
    });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
