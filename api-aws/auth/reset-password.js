// api/auth/reset-password.js (Lambda version)
//
// POST /api/auth/reset-password
//
// Validates a reset token and updates the user's password.
// Uses bcrypt for subaccount users, SHA-256 for agency (compatibility with login).
// Writes to subaccount_users for subaccount resets.
//
// MIGRATED: Supabase REST → lib/db.js for all queries.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_COST = 10;

function checkPasswordStrength(pass) {
  if (!pass || pass.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pass)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pass)) return 'Password must contain a number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) return 'Password must contain a special character.';
  return null;
}

async function handler(req, res) {
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
    // Look up token
    let rec;
    try {
      rec = await db.findOne('password_reset_tokens', { token: token });
    } catch (e) {
      return res.status(500).json({ error: 'Token lookup failed' });
    }
    if (!rec) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    if (rec.used_at) {
      return res.status(400).json({ error: 'This reset link has already been used.' });
    }
    if (new Date(rec.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    // Hash new password with bcrypt
    let newHash;
    try {
      newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    } catch (e) {
      return res.status(500).json({ error: 'Password hashing failed' });
    }

    const nowIso = new Date().toISOString();
    let userIdForRevoke = null;

    if (rec.user_type === 'agency') {
      // /agency portal removed (Phase 4C, May 30 2026). Stale tokens for
      // agency users are rejected; the user must request a new reset via
      // the LitBiz workspace path.
      return res.status(410).json({ error: 'Reset token no longer valid for this user type.' });

    } else if (rec.user_type === 'subaccount_user') {
      const isComposite = String(rec.user_identifier).indexOf(':') >= 0;

      if (!isComposite) {
        // Direct uuid - UPDATE existing row
        try {
          await db.update('subaccount_users',
            {
              password_hash: newHash,
              legacy_password_hash: null,
              password_changed_at: nowIso,
              must_change_password: false,
              active: true,
              updated_at: nowIso
            },
            { id: rec.user_identifier }
          );
        } catch (e) {
          return res.status(500).json({ error: 'Failed to update password: ' + e.message });
        }
        userIdForRevoke = rec.user_identifier;

      } else {
        // Composite 'subId:username'
        const parts = rec.user_identifier.split(':');
        const subId = parts[0];
        const username = parts[1];
        if (!subId || !username) {
          return res.status(400).json({ error: 'Invalid user identifier' });
        }

        // Try to find existing row
        let existingId = null;
        try {
          const r = await db.query(
            `SELECT id FROM subaccount_users
             WHERE subaccount_id = $1 AND username ILIKE $2
             LIMIT 1`,
            [subId, username]
          );
          if (r.rows && r.rows.length) existingId = r.rows[0].id;
        } catch (e) { /* swallow */ }

        if (existingId) {
          try {
            await db.update('subaccount_users',
              {
                password_hash: newHash,
                legacy_password_hash: null,
                password_changed_at: nowIso,
                must_change_password: false,
                active: true,
                updated_at: nowIso
              },
              { id: existingId }
            );
          } catch (e) {
            return res.status(500).json({ error: 'Failed to update password: ' + e.message });
          }
          userIdForRevoke = existingId;
        } else {
          // Create-new-user branch removed (Jun 2026). A password reset
          // must never provision an account. This composite path only
          // ever fired from the legacy subaccounts.admin_username fallback
          // in forgot-password, now cut. Any composite token still in
          // flight can update an existing row above; if no row matches,
          // we refuse rather than mint an admin.
          return res.status(400).json({
            error: 'No matching account for this reset link. Please request a new password reset.'
          });
        }
      }

    } else {
      return res.status(400).json({
        error: 'This reset link uses an outdated format. Please request a new password reset.'
      });
    }

    // Revoke active sessions for the user
    if (userIdForRevoke) {
      try {
        await db.update('sessions',
          { revoked_at: nowIso },
          { user_id: userIdForRevoke, revoked_at: { op: 'is_null' } }
        );
      } catch (e) {
        console.error('reset-password: session revocation failed:', e.message);
      }
    }

    // Mark token as used
    try {
      await db.update('password_reset_tokens',
        { used_at: nowIso },
        { token: token }
      );
    } catch (e) {
      console.error('reset-password: token mark used failed:', e.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Password updated. You can now log in.'
    });

  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
}

exports.handler = wrap(handler);
