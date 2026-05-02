const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const r = await db.query("SELECT data FROM subaccount_data WHERE subaccount_id='sub-litbiz'");
    const appts = r.rows[0]?.data?.appointments || [];
    const byAssignee = {};
    for (const a of appts) {
      const k = a.assignedTo || '(null)';
      byAssignee[k] = (byAssignee[k] || 0) + 1;
    }
    return res.status(200).json({ total: appts.length, by_assignee: byAssignee });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
