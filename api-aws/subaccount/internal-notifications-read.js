// POST /api/subaccount/internal-notifications-read
//
// Marks the current user's internal notifications read (or unread).
// Body: { id }        -> mark one read
//       { all: true } -> mark all the user's unread read
//       { id, unread: true } -> mark one unread (toggle back)
// Only affects rows owned by the calling user (recipient_user_id = auth.user_id).

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { id, all, unread } = req.body || {};
  const targetRead = unread ? false : true;

  try {
    if (all) {
      await db.query(
        `UPDATE internal_notifications SET is_read = true
          WHERE subaccount_id = $1 AND recipient_user_id = $2 AND is_read = false`,
        [auth.subaccount_id, auth.user_id]
      );
      return res.status(200).json({ success: true, scope: 'all' });
    }
    if (!id) return res.status(400).json({ error: 'id or all required' });
    await db.query(
      `UPDATE internal_notifications SET is_read = $3
        WHERE id = $1 AND subaccount_id = $2 AND recipient_user_id = $4`,
      [id, auth.subaccount_id, targetRead, auth.user_id]
    );
    return res.status(200).json({ success: true, id, is_read: targetRead });
  } catch (e) {
    console.error('internal-notifications-read error:', e.message);
    return res.status(500).json({ error: 'Failed to update notification' });
  }
}
exports.handler = wrap(handler);
