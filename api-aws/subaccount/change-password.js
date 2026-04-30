// api/subaccount/change-password.js (Lambda version)
//
// POST /api/subaccount/change-password
//
// Authenticated password change for subaccount users.
// Verifies current password before accepting new one. Stores new password
// as bcrypt and clears any remaining legacy SHA-256 hash.
// Revokes all other sessions for the user; issues a fresh session for current device.
//
// MIGRATED: Supabase REST → lib/db.js for user lookup and update.

const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
const {
  hashPassword,
  verifyBcrypt,
  verifyLegacySha256,
  parseSessionCookie,
  validateSession,
  revokeAllUserSessions,
  createSession,
  buildSessionCookie,
  getIpFromReq,
  getUserAgent
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

function checkStrength(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain a special character';
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session) {
    await logAudit({
      req,
      actorType: 'subaccount',
      action: 'subaccount.password.change.denied',
      outcome: 'denied',
      errorMessage: 'No valid session'
    });
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (String(session.user_id).startsWith('breakglass-')) {
    return res.status(403).json({ error: 'Break-glass session cannot change passwords. Use the database directly or log in as the real user.' });
  }

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }

  const strengthError = checkStrength(newPassword);
  if (strengthError) {
    return res.status(400).json({ error: strengthError });
  }

  // Load the user record
  let user;
  try {
    user = await db.findOne('subaccount_users', { id: session.user_id });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load user: ' + e.message });
  }
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Verify current password
  let validCurrent = false;
  if (user.password_hash) {
    validCurrent = await verifyBcrypt(currentPassword, user.password_hash);
  }
  if (!validCurrent && user.legacy_password_hash) {
    validCurrent = verifyLegacySha256(currentPassword, user.legacy_password_hash);
  }

  if (!validCurrent) {
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      action: 'subaccount.password.change.failure',
      targetType: 'subaccount_user',
      targetId: user.id,
      targetSubaccountId: user.subaccount_id,
      outcome: 'failure',
      errorMessage: 'Current password incorrect'
    });
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  // Hash new password and update
  const newHash = await hashPassword(newPassword);
  try {
    await db.update('subaccount_users',
      {
        password_hash: newHash,
        legacy_password_hash: null,
        password_changed_at: new Date().toISOString(),
        must_change_password: false
      },
      { id: user.id }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update password: ' + e.message });
  }

  await revokeAllUserSessions(user.id, 'subaccount', 'password_changed');

  const newSession = await createSession({
    userId: user.id,
    userType: 'subaccount',
    subaccountId: user.subaccount_id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    ipAddress: getIpFromReq(req),
    userAgent: getUserAgent(req)
  });

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: user.id,
    actorUsername: user.username,
    actorRole: user.role,
    action: 'subaccount.password.change.success',
    targetType: 'subaccount_user',
    targetId: user.id,
    targetSubaccountId: user.subaccount_id,
    metadata: {
      sessions_revoked: true,
      new_session_id: newSession.sessionId
    }
  });

  res.setHeader('Set-Cookie', buildSessionCookie(newSession.token));
  return res.status(200).json({ success: true });
}

exports.handler = wrap(handler);
