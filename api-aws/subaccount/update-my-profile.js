// api/subaccount/update-my-profile.js (Lambda version)
//
// POST /api/subaccount/update-my-profile
//
// Self-service profile update for the logged-in subaccount user.
// Operates strictly on session.user_id. Client cannot name a target.
//
//   phone  - any valid session, no password required, normalized to E.164
//   email  - REQUIRES currentPassword (email is the login identity).
//            On change: dedupe-checked, username kept in sync, all other
//            sessions revoked, fresh cookie issued for current device.
//
// Security:
//   - Auth: any valid subaccount session
//   - Email change gated by current-password verification (Option A)
//   - Audited (subaccount.user.self_update)

const db = require('./lib/db');
const {
  parseSessionCookie,
  validateSession,
  verifyBcrypt,
  verifyLegacySha256,
  revokeAllUserSessions,
  createSession,
  buildSessionCookie,
  getIpFromReq,
  getUserAgent
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { normalizePhone } = require('./lib/phone');
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
  if (String(session.user_id).startsWith('breakglass-')) {
    return res.status(403).json({ error: 'Break-glass session cannot edit profile.' });
  }

  const { phone, email, currentPassword } = req.body || {};
  if (phone === undefined && email === undefined) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  // Load own row
  let user;
  try {
    user = await db.findOne('subaccount_users', { id: session.user_id });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load user: ' + e.message });
  }
  if (!user) return res.status(404).json({ error: 'User not found' });

  const patch = {};
  const changedFields = [];

  // ---- Phone (no password required) ----
  if (phone !== undefined) {
    let normPhone = null;
    if (phone !== null && String(phone).trim() !== '') {
      normPhone = normalizePhone(phone);
      if (!normPhone) {
        return res.status(400).json({ error: 'Enter a valid phone number.' });
      }
    }
    if (normPhone !== (user.phone || null)) {
      patch.phone = normPhone;
      changedFields.push('phone');
    }
  }

  // ---- Email (password-gated) ----
  let emailChanged = false;
  if (email !== undefined) {
    const normEmail = email ? String(email).trim().toLowerCase() : '';
    if (!normEmail || normEmail.indexOf('@') < 0) {
      return res.status(400).json({ error: 'Enter a valid email.' });
    }
    if (normEmail !== (user.email || '').toLowerCase()) {
      // Email is login identity. Require current password.
      if (!currentPassword) {
        return res.status(400).json({ error: 'Enter your current password to change your email.' });
      }
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
          action: 'subaccount.user.self_update.denied',
          targetType: 'subaccount_user',
          targetId: user.id,
          targetSubaccountId: user.subaccount_id,
          outcome: 'denied',
          errorMessage: 'Current password incorrect for email change'
        });
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      // Dedupe within subaccount
      try {
        const dupe = await db.query(
          `SELECT id FROM subaccount_users
           WHERE subaccount_id = $1 AND LOWER(email) = $2 AND id <> $3
           LIMIT 1`,
          [user.subaccount_id, normEmail, user.id]
        );
        if (dupe.rows.length) {
          return res.status(409).json({ error: 'That email is already in use.' });
        }
      } catch (e) {
        return res.status(500).json({ error: 'Email check failed: ' + e.message });
      }
      patch.email = normEmail;
      patch.username = normEmail; // username IS email post-migration
      changedFields.push('email');
      emailChanged = true;
    }
  }

  if (!changedFields.length) {
    return res.status(200).json({ success: true, noChange: true, phone: user.phone || null, email: user.email || null });
  }

  patch.updated_at = new Date().toISOString();
  try {
    await db.update('subaccount_users', patch, { id: user.id });
  } catch (e) {
    return res.status(500).json({ error: 'Update failed: ' + e.message });
  }

  // Email change moves the login identity. Revoke other sessions, reissue cookie.
  let cookieReissued = false;
  if (emailChanged) {
    try {
      await revokeAllUserSessions(user.id, 'subaccount', 'email_changed');
      const newSession = await createSession({
        userId: user.id,
        userType: 'subaccount',
        subaccountId: user.subaccount_id,
        username: patch.username,
        displayName: user.display_name || patch.username,
        role: user.role,
        ipAddress: getIpFromReq(req),
        userAgent: getUserAgent(req)
      });
      res.setHeader('Set-Cookie', buildSessionCookie(newSession.token));
      cookieReissued = true;
    } catch (e) {
      console.error('update-my-profile: session reissue failed:', e.message);
    }
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: user.id,
    actorUsername: user.username,
    actorRole: user.role,
    action: 'subaccount.user.self_update',
    targetType: 'subaccount_user',
    targetId: user.id,
    targetSubaccountId: user.subaccount_id,
    metadata: { changed_fields: changedFields, email_changed: emailChanged }
  });

  return res.status(200).json({
    success: true,
    changedFields: changedFields,
    phone: patch.phone !== undefined ? patch.phone : (user.phone || null),
    email: patch.email || user.email || null,
    cookieReissued: cookieReissued
  });
}

exports.handler = wrap(handler);
