// api/auth/reset-password.js
//
// Validates a reset token and updates the user's password.
// Uses bcrypt to match what api/subaccount/login.js expects.
// Writes to subaccount_users table for subaccount resets (not the JSON blob).
// Writes to agency_users table for agency resets.
//
// user_identifier formats supported:
//   - bare uuid: existing row in subaccount_users / agency_users to UPDATE
//   - 'subId:username': legacy blob-only subaccount, create row in subaccount_users

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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

// Match the strength check used in change-password and the agency reset
function checkPasswordStrength(pass) {
  if (!pass || pass.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pass)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pass)) return 'Password must contain a number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) return 'Password must contain a special character.';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword required' });
  }

  const passErr = checkPasswordStrength(newPassword);
  if (passErr) {
    return res.status(400).json({ error: passErr });
  }

  try {
    // ── Look up token ──
    const rToken = await fetch(
      SUPABASE_URL + '/rest/v1/password_reset_tokens?token=eq.' + encodeURIComponent(token) + '&select=*',
      { headers: sbHeaders() }
    );
    if (!rToken.ok) return res.status(500).json({ error: 'Token lookup failed' });
    const tokens = await rToken.json();
    if (!tokens || !tokens.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    const rec = tokens[0];

    if (rec.used_at) {
      return res.status(400).json({ error: 'This reset link has already been used.' });
    }
    if (new Date(rec.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    // ── Hash new password with bcrypt (matches login.js) ──
    let newHash;
    try {
      newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    } catch (e) {
      return res.status(500).json({ error: 'Password hashing failed' });
    }

    const nowIso = new Date().toISOString();
    let userIdForRevoke = null;

    if (rec.user_type === 'agency') {
      // ── Agency user reset ──
      // KNOWN TECH DEBT: api/agency/login.js still uses SHA-256 (sends pre-hashed
      // password from frontend, compares directly). To stay compatible with that
      // login flow, agency password resets MUST write SHA-256 hashes, not bcrypt.
      // When agency auth is upgraded to bcrypt in a future session, this branch
      // should switch to using newHash (the bcrypt) instead.
      // agency_users schema: id, username, password_hash, name, role, active,
      // email, created_at, updated_at. No legacy_password_hash column.
      const sha256Hash = crypto.createHash('sha256').update(newPassword).digest('hex');
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/agency_users?id=eq.' + encodeURIComponent(rec.user_identifier),
        {
          method: 'PATCH',
          headers: sbHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({
            password_hash: sha256Hash,
            updated_at: nowIso
          })
        }
      );
      if (!r.ok) {
        const errText = await r.text();
        console.error('reset-password agency_users update failed:', errText);
        return res.status(500).json({ error: 'Failed to update password: ' + errText });
      }
      userIdForRevoke = rec.user_identifier;

    } else if (rec.user_type === 'subaccount_user') {
      // ── Subaccount user reset ──
      // user_identifier is either a uuid (existing row) or 'subId:username' (legacy fallback)
      const isComposite = String(rec.user_identifier).indexOf(':') >= 0;

      if (!isComposite) {
        // Direct uuid - UPDATE existing subaccount_users row
        const r = await fetch(
          SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + encodeURIComponent(rec.user_identifier),
          {
            method: 'PATCH',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({
              password_hash: newHash,
              legacy_password_hash: null,
              password_changed_at: nowIso,
              must_change_password: false,  // user picked it themselves
              active: true,
              updated_at: nowIso
            })
          }
        );
        if (!r.ok) return res.status(500).json({ error: 'Failed to update password: ' + await r.text() });
        userIdForRevoke = rec.user_identifier;

      } else {
        // Composite 'subId:username' - lookup or create row
        const parts = rec.user_identifier.split(':');
        const subId = parts[0];
        const username = parts[1];
        if (!subId || !username) {
          return res.status(400).json({ error: 'Invalid user identifier' });
        }

        // Try to find existing row first (race-safe in case agency reset already created one)
        let existingId = null;
        try {
          const r = await fetch(
            SUPABASE_URL + '/rest/v1/subaccount_users'
            + '?subaccount_id=eq.' + encodeURIComponent(subId)
            + '&username=ilike.' + encodeURIComponent(username)
            + '&select=id&limit=1',
            { headers: sbHeaders() }
          );
          if (r.ok) {
            const rows = await r.json();
            if (rows && rows.length) existingId = rows[0].id;
          }
        } catch (e) { /* swallow, will create */ }

        if (existingId) {
          // UPDATE
          const r = await fetch(
            SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + encodeURIComponent(existingId),
            {
              method: 'PATCH',
              headers: sbHeaders({ 'Prefer': 'return=minimal' }),
              body: JSON.stringify({
                password_hash: newHash,
                legacy_password_hash: null,
                password_changed_at: nowIso,
                must_change_password: false,
                active: true,
                updated_at: nowIso
              })
            }
          );
          if (!r.ok) return res.status(500).json({ error: 'Failed to update password: ' + await r.text() });
          userIdForRevoke = existingId;
        } else {
          // CREATE - subaccount where admin only existed in JSON blob
          const newId = crypto.randomUUID();
          const r = await fetch(SUPABASE_URL + '/rest/v1/subaccount_users', {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'return=representation' }),
            body: JSON.stringify({
              id: newId,
              subaccount_id: subId,
              username: username,
              email: rec.email,
              display_name: username,
              password_hash: newHash,
              role: 'admin',  // Forgot-password lookup matched on subaccounts.admin_email, so this is the admin
              active: true,
              must_change_password: false,
              password_changed_at: nowIso
            })
          });
          if (!r.ok) return res.status(500).json({ error: 'Failed to create user: ' + await r.text() });
          userIdForRevoke = newId;
        }
      }

    } else {
      // Unknown or legacy user_type (subaccount_admin, subaccount_staff from old forgot-password.js)
      return res.status(400).json({
        error: 'This reset link uses an outdated format. Please request a new password reset.'
      });
    }

    // ── Revoke active sessions for the user ──
    // New password should kick in immediately. Without this, an attacker holding
    // a valid session for the old password could keep operating until expiry.
    if (userIdForRevoke) {
      try {
        await fetch(
          SUPABASE_URL + '/rest/v1/sessions'
          + '?user_id=eq.' + encodeURIComponent(userIdForRevoke)
          + '&revoked_at=is.null',
          {
            method: 'PATCH',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ revoked_at: nowIso })
          }
        );
      } catch (e) {
        console.error('reset-password: session revocation failed:', e.message);
      }
    }

    // ── Mark token as used ──
    await fetch(
      SUPABASE_URL + '/rest/v1/password_reset_tokens?token=eq.' + encodeURIComponent(token),
      {
        method: 'PATCH',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ used_at: nowIso })
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Password updated. You can now log in.'
    });

  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
};
