// api/agency/reset-subaccount-password.js (Lambda version)
//
// POST /api/agency/reset-subaccount-password
//
// Agency-side endpoint to reset a subaccount admin's password.
// Super_admin only. Uses bcrypt. Revokes any active sessions.
// Sets must_change_password=true.
//
// MIGRATED: Supabase REST → lib/db.js for all queries.

const db = require('./lib/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const BCRYPT_COST = 10;

function checkPasswordStrength(pass) {
  if (!pass || pass.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pass)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pass)) return 'Password must contain a number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) return 'Password must contain a special character.';
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { subaccountId, newPassword } = req.body || {};
  if (!subaccountId) return res.status(400).json({ error: 'subaccountId required' });
  if (!newPassword) return res.status(400).json({ error: 'newPassword required' });

  const passErr = checkPasswordStrength(newPassword);
  if (passErr) return res.status(400).json({ error: passErr });

  // Look up the subaccount
  let sub;
  try {
    sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'id, slug, name, admin_username' }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load subaccount: ' + e.message });
  }
  if (!sub) return res.status(404).json({ error: 'Subaccount not found' });

  if (!sub.admin_username) {
    return res.status(400).json({ error: 'Subaccount has no admin_username on file. Cannot determine which user to reset.' });
  }

  // Hash new password
  let newHash;
  try {
    newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  } catch (e) {
    return res.status(500).json({ error: 'Hash failed: ' + e.message });
  }

  // Find the admin user (case-insensitive)
  let user = null;
  try {
    const r = await db.query(
      `SELECT * FROM subaccount_users
       WHERE subaccount_id = $1 AND username ILIKE $2
       LIMIT 1`,
      [subaccountId, sub.admin_username]
    );
    user = r.rows[0] || null;
  } catch (e) {
    return res.status(500).json({ error: 'User lookup failed: ' + e.message });
  }

  const nowIso = new Date().toISOString();
  let userIdForAudit;

  if (user) {
    // Update existing
    try {
      await db.update('subaccount_users',
        {
          password_hash: newHash,
          legacy_password_hash: null,
          must_change_password: true,
          password_changed_at: nowIso,
          active: true,
          updated_at: nowIso
        },
        { id: user.id }
      );
      userIdForAudit = user.id;
    } catch (e) {
      return res.status(500).json({ error: 'Update failed: ' + e.message });
    }
  } else {
    // Create new row (legacy blob-only subaccount)
    const newId = crypto.randomUUID();
    try {
      await db.insertOne('subaccount_users', {
        id: newId,
        subaccount_id: subaccountId,
        username: sub.admin_username,
        display_name: sub.admin_username,
        password_hash: newHash,
        must_change_password: true,
        role: 'admin',
        active: true,
        password_changed_at: nowIso
      });
      userIdForAudit = newId;
    } catch (e) {
      return res.status(500).json({ error: 'Create user failed: ' + e.message });
    }
  }

  // Revoke active sessions
  let sessionsRevoked = 0;
  if (userIdForAudit) {
    try {
      const revoked = await db.update('sessions',
        { revoked_at: nowIso },
        { user_id: userIdForAudit, revoked_at: { op: 'is_null' } }
      );
      sessionsRevoked = revoked.length;
    } catch (e) {
      console.error('reset-subaccount-password: session revocation failed:', e.message);
    }
  }

  // Audit
  await logAudit({
    req,
    actorType:    'agency_admin',
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
}

exports.handler = wrap(handler);
