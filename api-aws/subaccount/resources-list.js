// GET /api/subaccount/resources-list
// Returns all resources for the authed subaccount.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const r = await db.query(
      `SELECT id, subaccount_id, name, type, capacity, buffer_after,
              active, display_order, notes, created_at, updated_at
       FROM resources
       WHERE subaccount_id = $1
       ORDER BY COALESCE(display_order, 9999), name`,
      [auth.subaccount_id]
    );
    return res.status(200).json({ success: true, resources: r.rows });
  } catch (e) {
    console.error('resources-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load resources' });
  }
}
exports.handler = wrap(handler);
