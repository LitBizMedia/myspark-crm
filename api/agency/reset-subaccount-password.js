// api/agency/reset-subaccount-password.js
//
// Agency-side endpoint to reset a subaccount admin's password.
// Super_admin only. Uses bcrypt to match the login flow's hashing scheme.
// Revokes any active sessions for that user so the new password takes effect
// immediately (forces re-login with new credentials).
//
// Sets must_change_password=true so the customer is prompted to change the
// admin-set password on next login. HIPAA best practice for admin-initiated
// password resets.
//
// If no row exists in subaccount_users for the subaccount's admin (legacy
// blob-only subaccounts), creates one. The username is read from
// subaccounts.admin_username.
//
// Body: { subaccountId, newPassword }

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAgencyAuth } = require('../../lib/require-subaccount-auth');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BCRYPT_COST = 10;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function checkPasswordStrength(pass) {
  if (!pass || pass.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pass)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pass)) return 'Password must contain a number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) return 'Password must contain a special character.';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Super_admin only
  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return; // 401/403 already sent

  const { subaccountId, newPassword } = req.body || {};
  if (!subaccountId) return res.status(400).json({ error: 'subaccountId required' });
  if (!newPassword) return res.status(400).json({ error: 'newPassword required' });

  const passErr = checkPasswordStrength(newPassword);
  if (passErr) return res.status(400).json({ error: passErr });

  // Look up the subaccount to get the admin username
  let sub;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + encodeURIComponent(subaccountId) + '&select=id,slug,name,admin_username',
      { headers: sbHeaders() }
    );
    if (!r.ok) return res.status(500).json({ error: 'Failed to load subaccount: ' + await r.text() });
    const rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ error: 'Subaccount not found' });
    sub = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load subaccount: ' + e.message });
  }

  if (!sub.admin_username) {
    return res.status(400).json({ error: 'Subaccount has no admin_username on file. Cannot determine which user to reset.' });
  }

  // Hash the new password with bcrypt (matches login.js verification)
  let newHash;
  try {
    newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  } catch (e) {
    return res.status(500).json({ error: 'Hash failed: ' + e.message });
  }

  // Find the admin user in subaccount_users
  let user = null;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_users'
      + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
      + '&username=ilike.' + encodeURIComponent(sub.admin_username)
      + '&select=*',
      { headers: sbHeaders() }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows.length) user = rows[0];
    }
  } catch (e) {
    return res.status(500).json({ error: 'User lookup failed: ' + e.message });
  }

  const nowIso = new Date().toISOString();
  let userIdForAudit;

  if (user) {
    // Update existing user row
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + encodeURIComponent(user.id),
        {
          method: 'PATCH',
          headers: sbHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({
            password_hash: newHash,
            legacy_password_hash: null,
            must_change_password: true,
            password_changed_at: nowIso,
            active: true,  // re-activate if it was somehow inactive
            updated_at: nowIso
          })
        }
      );
      if (!r.ok) {
        return res.status(500).json({ error: 'Failed to update user: ' + await r.text() });
      }
      userIdForAudit = user.id;
    } catch (e) {
      return res.status(500).json({ error: 'Update failed: ' + e.message });
    }
  } else {
    // No row exists. Create one. This handles legacy subaccounts where the
    // admin has only ever been in the JSON blob.
    // Use crypto.randomUUID() because subaccount_users.id is a uuid column,
    // not text. (Found out the hard way during testing - thanks Patrick.)
    const newId = crypto.randomUUID();
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/subaccount_users', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          id: newId,
          subaccount_id: subaccountId,
          username: sub.admin_username,
          display_name: sub.admin_username,
          password_hash: newHash,
          must_change_password: true,
          role: 'admin',
          active: true,
          password_changed_at: nowIso
        })
      });
      if (!r.ok) {
        return res.status(500).json({ error: 'Failed to create user row: ' + await r.text() });
      }
      const created = await r.json();
      userIdForAudit = (Array.isArray(created) ? created[0].id : created.id) || newId;
    } catch (e) {
      return res.status(500).json({ error: 'Create user failed: ' + e.message });
    }
  }

  // Revoke any active sessions for this user so the new password kicks in
  // immediately. Without this, an attacker (or compromised user) with an
  // existing session could keep operating until session expiry.
  let sessionsRevoked = 0;
  if (userIdForAudit) {
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/sessions'
        + '?user_id=eq.' + encodeURIComponent(userIdForAudit)
        + '&revoked_at=is.null',
        {
          method: 'PATCH',
          headers: sbHeaders({ 'Prefer': 'return=representation' }),
          body: JSON.stringify({ revoked_at: nowIso })
        }
      );
      if (r.ok) {
        const revoked = await r.json();
        sessionsRevoked = Array.isArray(revoked) ? revoked.length : 0;
      }
    } catch (e) {
      console.error('reset-subaccount-password: session revocation failed:', e.message);
      // Non-fatal - the password is reset, sessions will expire on their own
    }
  }

  // Audit the reset
  await logAudit({
    req,
    actorType:    'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role,
    action: 'agency.subaccount.password_reset',
    targetType: 'subaccount_user',
    targetId: userIdForAudit,
    targetSubaccountId: subaccountId,
    metadata: {
      subaccount_slug:   sub.slug,
      subaccount_name:   sub.name,
      target_username:   sub.admin_username,
      sessions_revoked:  sessionsRevoked,
      created_user_row:  !user
    }
  });

  return res.status(200).json({
    success: true,
    sessions_revoked: sessionsRevoked,
    must_change_password: true
  });
};
