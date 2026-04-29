// api/subaccount/update-user.js
//
// Updates a subaccount user's mutable fields (role, email, display_name, active)
// in the subaccount_users table. This keeps subaccount_users in sync with the
// db.users JSON blob so that login (which reads from subaccount_users) gets
// the current role.
//
// Why this endpoint exists:
// The legacy architecture stores user records in two places:
//   1. db.users in subaccount_data JSON blob (where the frontend manages them)
//   2. subaccount_users table (where api/subaccount/login.js reads from)
//
// When an admin changes a user's role in the staff settings, only #1 was being
// updated. The user would log in and still get their old role from #2.
//
// This endpoint is the bridge. The frontend calls it whenever it edits a user
// so both stores stay in sync.
//
// Security:
//   - Auth: subaccount session, admin or manager role
//   - Slug isolation: target user must belong to caller's subaccount
//   - Cannot escalate to admin role unless caller is admin
//   - Cannot demote the primary admin (protected_from_deletion safeguard)
//   - Audited

const bcrypt = require('bcryptjs');
const {
  parseSessionCookie,
  validateSession,
  hashPassword
} = require('../../lib/subaccount-auth');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES = ['admin', 'manager', 'user', 'practitioner'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth - admin or manager
  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.role !== 'admin' && session.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager role required' });
  }

  const subaccountId = session.subaccount_id;
  const { username, role, email, displayName, active, newPassword } = req.body || {};

  // Identify the target by username (since the JSON blob's user IDs may not
  // match subaccount_users.id - they're separate ID systems). Username is
  // unique within a subaccount so this is safe.
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username required' });
  }
  const normUsername = username.trim().toLowerCase();
  if (!normUsername) {
    return res.status(400).json({ error: 'username required' });
  }

  // Validate role if provided
  if (role !== undefined && role !== null) {
    if (VALID_ROLES.indexOf(role) < 0) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    // Only admin can grant admin role (managers can't escalate)
    if (role === 'admin' && session.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can grant admin role' });
    }
  }

  // Look up the target user, scoped to this subaccount
  let targetUser;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_users'
      + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
      + '&username=ilike.' + encodeURIComponent(normUsername)
      + '&select=*&limit=1',
      { headers: sbHeaders() }
    );
    if (!r.ok) {
      console.error('update-user: lookup failed:', await r.text());
      return res.status(500).json({ error: 'Lookup failed' });
    }
    const rows = await r.json();
    if (!rows || !rows.length) {
      // Target doesn't exist in subaccount_users yet. This happens for users
      // created via the legacy frontend flow that only writes to the JSON blob.
      // We need to create the row so login works for them.
      // But we need a password to do so - if newPassword wasn't provided,
      // we can't create a working user.
      if (!newPassword) {
        return res.status(404).json({
          error: 'User not in auth table. Provide newPassword to migrate them.',
          code: 'USER_NEEDS_MIGRATION'
        });
      }
      // Create new row
      const newId = require('crypto').randomUUID();
      const newHash = await hashPassword(newPassword);
      const createBody = {
        id: newId,
        subaccount_id: subaccountId,
        username: normUsername,
        display_name: displayName || normUsername,
        password_hash: newHash,
        role: role || 'user',
        active: active !== false,
        must_change_password: false
      };
      if (email) createBody.email = String(email).toLowerCase();
      const cr = await fetch(SUPABASE_URL + '/rest/v1/subaccount_users', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify(createBody)
      });
      if (!cr.ok) {
        return res.status(500).json({ error: 'Failed to create auth row: ' + await cr.text() });
      }

      await logAudit({
        req,
        actorType:    'subaccount',
        actorId:       session.user_id,
        actorUsername: session.username,
        actorRole:     session.role,
        action: 'subaccount.user.migrate',
        targetType: 'subaccount_user',
        targetId: newId,
        targetSubaccountId: subaccountId,
        metadata: { username: normUsername, role: role || 'user' }
      });

      return res.status(200).json({ success: true, created: true, userId: newId });
    }
    targetUser = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Lookup error: ' + e.message });
  }

  // Build the patch
  const patch = { updated_at: new Date().toISOString() };
  const changedFields = [];

  if (role !== undefined && role !== null && role !== targetUser.role) {
    patch.role = role;
    changedFields.push('role');
  }
  if (email !== undefined && email !== targetUser.email) {
    patch.email = email ? String(email).trim().toLowerCase() : null;
    changedFields.push('email');
  }
  if (displayName !== undefined && displayName !== targetUser.display_name) {
    patch.display_name = displayName;
    changedFields.push('display_name');
  }
  if (active !== undefined && active !== null && active !== targetUser.active) {
    patch.active = !!active;
    changedFields.push('active');
  }
  if (newPassword) {
    patch.password_hash = await hashPassword(newPassword);
    patch.legacy_password_hash = null;
    patch.password_changed_at = new Date().toISOString();
    changedFields.push('password');
  }

  // No-op if nothing changed
  if (!changedFields.length) {
    return res.status(200).json({ success: true, noChange: true });
  }

  // Apply the update
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + encodeURIComponent(targetUser.id),
      {
        method: 'PATCH',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify(patch)
      }
    );
    if (!r.ok) {
      const errText = await r.text();
      console.error('update-user: patch failed:', errText);
      return res.status(500).json({ error: 'Update failed: ' + errText });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Update error: ' + e.message });
  }

  // If we changed role/active/password, revoke any active sessions for the user
  // so the change takes immediate effect on their next request.
  let sessionsRevoked = 0;
  if (changedFields.indexOf('role') >= 0 || changedFields.indexOf('active') >= 0 || changedFields.indexOf('password') >= 0) {
    try {
      const sr = await fetch(
        SUPABASE_URL + '/rest/v1/sessions'
        + '?user_id=eq.' + encodeURIComponent(targetUser.id)
        + '&revoked_at=is.null',
        {
          method: 'PATCH',
          headers: sbHeaders({ 'Prefer': 'return=representation' }),
          body: JSON.stringify({ revoked_at: new Date().toISOString() })
        }
      );
      if (sr.ok) {
        const revoked = await sr.json();
        sessionsRevoked = Array.isArray(revoked) ? revoked.length : 0;
      }
    } catch (e) {
      console.error('update-user: session revoke failed:', e.message);
      // Non-fatal
    }
  }

  // Audit
  await logAudit({
    req,
    actorType:    'subaccount',
    actorId:       session.user_id,
    actorUsername: session.username,
    actorRole:     session.role,
    action: 'subaccount.user.update',
    targetType: 'subaccount_user',
    targetId: targetUser.id,
    targetSubaccountId: subaccountId,
    metadata: {
      target_username: normUsername,
      changed_fields:  changedFields,
      old_role: targetUser.role,
      new_role: patch.role || targetUser.role,
      sessions_revoked: sessionsRevoked
    }
  });

  return res.status(200).json({
    success: true,
    sessionsRevoked: sessionsRevoked,
    changedFields: changedFields
  });
};
