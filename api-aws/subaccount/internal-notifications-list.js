// GET /api/subaccount/internal-notifications-list
//
// Returns the current staff user's internal (staff) notifications: bell records
// written by the staff-notify dispatcher. Filtered to recipient_user_id =
// auth.user_id. Capped at the 50 most recent so the bell stays fast; older
// records remain in the table for any future history view.
//
// Response: { notifications: [ {id, type_key, title, body, link_type, link_id,
//                               actor_name, is_read, created_at}, ... ] }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const r = await db.query(
      `SELECT id, type_key, title, body, link_type, link_id, actor_name, is_read, created_at
         FROM internal_notifications
        WHERE subaccount_id = $1 AND recipient_user_id = $2
        ORDER BY created_at DESC
        LIMIT 50`,
      [auth.subaccount_id, auth.user_id]
    );
    return res.status(200).json({ notifications: r.rows });
  } catch (e) {
    console.error('internal-notifications-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
}
exports.handler = wrap(handler);
