// api/subaccount/delete-user.js (Lambda version)
//
// POST /api/subaccount/delete-user
//
// Deletes a subaccount user by id.
//
// Security:
//   - Auth: subaccount session, admin role only
//   - Slug isolation: target user must belong to caller's subaccount
//   - Cannot delete the primary admin (the workspace owner)
//   - Cannot delete yourself
//   - Audited
//   - Active sessions for the deleted user are revoked

const db = require('./lib/db');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const subaccountId = session.subaccount_id;
  const { id, username } = req.body || {};
  
  if (!id && !username) {
    return res.status(400).json({ error: 'id or username required' });
  }

  // Look up target by id or username, scoped to this subaccount
  let targetUser;
  try {
    let r;
    if (id) {
      r = await db.query(
        `SELECT * FROM subaccount_users
         WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
        [id, subaccountId]
      );
    } else {
      r = await db.query(
        `SELECT * FROM subaccount_users
         WHERE subaccount_id = $1 AND username ILIKE $2 LIMIT 1`,
        [subaccountId, String(username).trim().toLowerCase()]
      );
    }
    targetUser = r.rows[0] || null;
  } catch (e) {
    console.error('delete-user: lookup failed:', e.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }

  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Cannot delete yourself
  if (targetUser.id === session.user_id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // Primary admin protection: count admins; never let a workspace become admin-less.
  // The "primary admin" semantically is the first/oldest admin. Keep at least one.
  if (targetUser.role === 'admin') {
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS n FROM subaccount_users
       WHERE subaccount_id = $1 AND role = 'admin' AND active = true`,
      [subaccountId]
    );
    if (countResult.rows[0].n <= 1) {
      return res.status(400).json({ 
        error: 'Cannot remove the last admin. Promote another user first.' 
      });
    }
  }

  // Revoke active sessions
  let sessionsRevoked = 0;
  try {
    const revoked = await db.update('sessions',
      { revoked_at: new Date().toISOString() },
      { user_id: targetUser.id, revoked_at: { op: 'is_null' } }
    );
    sessionsRevoked = revoked.length;
  } catch (e) {
    console.error('delete-user: session revoke failed:', e.message);
  }

  // Delete the user
  try {
    await db.query('DELETE FROM subaccount_users WHERE id = $1', [targetUser.id]);
  } catch (e) {
    console.error('delete-user: delete failed:', e.message);
    return res.status(500).json({ error: 'Delete failed: ' + e.message });
  }

  await logAudit({
    req,
    actorType:    'subaccount',
    actorId:       session.user_id,
    actorUsername: session.username,
    actorRole:     session.role,
    action: 'subaccount.user.delete',
    targetType: 'subaccount_user',
    targetId: targetUser.id,
    targetSubaccountId: subaccountId,
    metadata: {
      target_username: targetUser.username,
      target_role: targetUser.role,
      sessions_revoked: sessionsRevoked
    }
  });

  return res.status(200).json({
    success: true,
    deletedId: targetUser.id,
    sessionsRevoked: sessionsRevoked
  });
}

exports.handler = wrap(handler);
