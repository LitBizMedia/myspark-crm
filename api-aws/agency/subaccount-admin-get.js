// api/agency/subaccount-admin-get.js (Lambda version)
//
// GET /api/agency/subaccount-admin-get?subaccountId=X
//
// Returns the primary admin user info for a subaccount. Used by the
// agency dashboard's Edit Subaccount modal to pre-fill admin name and
// username fields before allowing edits.
//
// Auth: any authenticated agency user. Editing requires super_admin
// (enforced by subaccount-admin-update).

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const { subaccountId } = req.query || {};
  if (!subaccountId) return res.status(400).json({ error: 'subaccountId required' });

  // Look up the subaccount to find its admin_username
  let sub;
  try {
    sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'id, slug, name, admin_username, admin_email' }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load subaccount: ' + e.message });
  }
  if (!sub) return res.status(404).json({ error: 'Subaccount not found' });

  // If no admin_username on the subaccounts row, return what we have.
  if (!sub.admin_username) {
    return res.status(200).json({
      admin: null,
      subaccount: { id: sub.id, slug: sub.slug, name: sub.name }
    });
  }

  // Look up the admin user in subaccount_users by case-insensitive username
  let user = null;
  try {
    const r = await db.query(
      `SELECT id, username, display_name, email, color, role, active,
              must_change_password, created_at, last_login_at
       FROM subaccount_users
       WHERE subaccount_id = $1 AND username ILIKE $2
       LIMIT 1`,
      [subaccountId, sub.admin_username]
    );
    user = r.rows[0] || null;
  } catch (e) {
    return res.status(500).json({ error: 'User lookup failed: ' + e.message });
  }

  return res.status(200).json({
    admin: user,
    subaccount: {
      id: sub.id,
      slug: sub.slug,
      name: sub.name,
      admin_username: sub.admin_username,
      admin_email: sub.admin_email
    }
  });
}

exports.handler = wrap(handler);
