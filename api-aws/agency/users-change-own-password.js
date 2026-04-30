// api/agency/users-change-own-password.js (Lambda version)
// POST /api/agency/users-change-own-password
// User changes their own password. Verifies old password.

const crypto = require('crypto');
const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function checkPasswordStrength(p) {
  if (!p || p.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(p)) return 'Password must contain an uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must contain a number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must contain a special character';
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword required' });
  if (oldPassword === newPassword) return res.status(400).json({ error: 'New password must differ from current' });

  const passErr = checkPasswordStrength(newPassword);
  if (passErr) return res.status(400).json({ error: passErr });

  try {
    const oldHash = sha256(oldPassword);
    const verify = await db.query('SELECT password_hash FROM agency_users WHERE id = $1', [auth.user_id]);
    if (verify.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const stored = verify.rows[0].password_hash;
    // Allow fallback hash match if DB record missing (matches frontend disaster recovery)
    const okOld = stored === oldHash || (auth.user_id === 'agency-admin-primary' && !stored && oldHash === process.env.AGENCY_FALLBACK_HASH);
    if (!okOld) return res.status(403).json({ error: 'Current password is incorrect' });

    const newHash = sha256(newPassword);
    await db.query(
      'UPDATE agency_users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, auth.user_id]
    );

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.user.change_own_password',
      targetType: 'agency_user',
      targetId: auth.user_id,
      metadata: {}
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('users-change-own-password error:', e.message);
    return res.status(500).json({ error: 'Failed to change password' });
  }
}

exports.handler = wrap(handler);
