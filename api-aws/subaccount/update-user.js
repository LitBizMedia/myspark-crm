// api/subaccount/update-user.js (Lambda version)
//
// POST /api/subaccount/update-user
//
// Updates a subaccount user's mutable fields (role, email, display_name, active,
// is_agency_admin) in the subaccount_users table. Keeps subaccount_users in sync
// with the db.users JSON blob so login gets the current role.
//
// Security:
//   - Auth: subaccount session, admin or manager role
//   - Slug isolation: target user must belong to caller's subaccount
//   - Cannot escalate to admin role unless caller is admin
//   - Cannot write is_agency_admin unless caller is is_agency_admin
//   - Cannot grant is_agency_admin in a non-agency-workspace subaccount
//   - Audited (escalation attempts logged with actorType='agency_admin')
//
// MIGRATED: Supabase REST → lib/db.js for all user/session queries.

const db = require('./lib/db');
const {
  parseSessionCookie,
  validateSession,
  hashPassword
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const crypto = require('crypto');

const VALID_ROLES = ['admin', 'manager', 'user', 'practitioner'];

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.role !== 'admin' && session.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager role required' });
  }

  const subaccountId = session.subaccount_id;
  const { username, role, email, displayName, active, newPassword, color, schedule, dateOverrides, isAgencyAdmin, magicLinkOnly } = req.body || {};
  // Accept email as identifier when username not provided (post email-as-login migration)
  const identifier = username || email;

  if (!identifier || typeof identifier !== 'string') {
    return res.status(400).json({ error: 'username or email required' });
  }
  const normUsername = identifier.trim().toLowerCase();
  if (!normUsername) {
    return res.status(400).json({ error: 'username or email required' });
  }

  if (role !== undefined && role !== null) {
    if (VALID_ROLES.indexOf(role) < 0) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (role === 'admin' && session.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can grant admin role' });
    }
  }

  // is_agency_admin gate. Only callers who are themselves agency admins can
  // grant or revoke the flag. Target subaccount must be flagged as agency
  // workspace. Live DB checks, no session caching.
  if (isAgencyAdmin !== undefined && isAgencyAdmin !== null) {
    let callerRow;
    try {
      callerRow = await db.findOne('subaccount_users', { id: session.user_id });
    } catch (e) {
      console.error('update-user: caller agency check failed:', e.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
    if (!callerRow || callerRow.is_agency_admin !== true) {
      await logAudit({
        req,
        actorType: 'agency_admin',
        actorId: session.user_id,
        actorUsername: session.username,
        actorRole: session.role,
        action: 'agency.privilege.escalation_attempt',
        targetType: 'subaccount_user',
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'Non-agency-admin attempted to write is_agency_admin',
        metadata: { target_username: normUsername, attempted_value: !!isAgencyAdmin }
      });
      return res.status(403).json({ error: 'Only agency admins can modify is_agency_admin' });
    }

    if (isAgencyAdmin === true) {
      let plan;
      try {
        plan = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
      } catch (e) {
        console.error('update-user: workspace check failed:', e.message);
        return res.status(500).json({ error: 'Permission check failed' });
      }
      if (!plan || plan.is_agency_workspace !== true) {
        await logAudit({
          req,
          actorType: 'agency_admin',
          actorId: session.user_id,
          actorUsername: session.username,
          actorRole: session.role,
          action: 'agency.privilege.escalation_attempt',
          targetType: 'subaccount_user',
          targetSubaccountId: subaccountId,
          outcome: 'denied',
          errorMessage: 'Cannot grant is_agency_admin in non-agency-workspace subaccount',
          metadata: { target_username: normUsername }
        });
        return res.status(403).json({ error: 'Subaccount is not an agency workspace' });
      }
    }
  }

  // Look up the target user, scoped to this subaccount.
  // Tries username AND email match since they're now usually the same.
  let targetUser;
  try {
    const r = await db.query(
      `SELECT * FROM subaccount_users
       WHERE subaccount_id = $1
         AND (username ILIKE $2 OR LOWER(email) = $2)
       LIMIT 1`,
      [subaccountId, normUsername]
    );
    targetUser = r.rows[0] || null;
  } catch (e) {
    console.error('update-user: lookup failed:', e.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }

  if (!targetUser) {
    // Create new user via magic-link flow.
    // We require an email (which is also the username post-migration).
    if (!email) {
      return res.status(400).json({ error: 'email required to create user' });
    }
    const normEmail = String(email).trim().toLowerCase();
    if (!normEmail || normEmail.indexOf('@') < 0) {
      return res.status(400).json({ error: 'valid email required' });
    }

    // Look up subaccount slug for the magic link
    let subSlug;
    try {
      const subRow = await db.findOne('subaccounts',
        { id: subaccountId },
        { select: 'slug, name' }
      );
      if (!subRow) return res.status(404).json({ error: 'Subaccount not found' });
      subSlug = subRow.slug;
    } catch (e) {
      return res.status(500).json({ error: 'Subaccount lookup failed: ' + e.message });
    }

    // Generate throwaway password hash. User will set their own via magic link.
    const newId = crypto.randomUUID();
    const tempPass = 'temp_' + crypto.randomBytes(16).toString('hex') + 'A1!';
    const newHash = await hashPassword(tempPass);
    const createBody = {
      id: newId,
      subaccount_id: subaccountId,
      username: normEmail, // username IS email post-migration
      email: normEmail,
      display_name: displayName || normEmail,
      password_hash: newHash,
      role: role || 'user',
      active: active !== false,
      must_change_password: true
    };
    if (color) createBody.color = color;
    if (schedule) createBody.schedule = JSON.stringify(schedule);
    if (dateOverrides) createBody.date_overrides = JSON.stringify(dateOverrides);
    if (isAgencyAdmin === true) createBody.is_agency_admin = true;

    try {
      await db.insertOne('subaccount_users', createBody);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to create user: ' + e.message });
    }

    // Generate magic-link token (7 day expiry for setup)
    let magicLinkSent = false;
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db.insertOne('password_reset_tokens', {
        token: token,
        user_type: 'subaccount_user',
        user_identifier: newId,
        subaccount_slug: subSlug,
        email: normEmail,
        expires_at: expiresAt
      });
      const setupUrl = 'https://mysparkplus.app/' + subSlug + '?reset=' + token;
      const loginUrl = 'https://mysparkplus.app/' + subSlug;
      const agencyEmails = require('./lib/agency-emails');
      await agencyEmails.sendEmail(normEmail, 'welcome_subaccount', {
        subName: subSlug,
        adminName: displayName || normEmail,
        slug: subSlug,
        loginUrl: loginUrl,
        adminEmail: normEmail,
        setupUrl: setupUrl,
        subaccountId: subaccountId
      });
      magicLinkSent = true;
    } catch (e) {
      console.error('update-user: magic link send failed:', e.message);
      // User was created; magic link can be resent later
    }

    await logAudit({
      req,
      actorType:    'subaccount',
      actorId:       session.user_id,
      actorUsername: session.username,
      actorRole:     session.role,
      action: 'subaccount.user.create',
      targetType: 'subaccount_user',
      targetId: newId,
      targetSubaccountId: subaccountId,
      metadata: {
        email: normEmail,
        role: role || 'user',
        magic_link_sent: magicLinkSent,
        is_agency_admin: !!createBody.is_agency_admin
      }
    });

    return res.status(200).json({
      success: true,
      created: true,
      userId: newId,
      magicLinkSent: magicLinkSent
    });
  }

  // Magic-link-only branch: send password reset link without changing password
  if (magicLinkOnly) {
    if (!targetUser.email) {
      return res.status(400).json({ error: 'User has no email on file' });
    }
    try {
      const subRow = await db.findOne('subaccounts',
        { id: subaccountId },
        { select: 'slug, name' }
      );
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await db.insertOne('password_reset_tokens', {
        token: token,
        user_type: 'subaccount_user',
        user_identifier: targetUser.id,
        subaccount_slug: subRow.slug,
        email: targetUser.email,
        expires_at: expiresAt
      });
      const resetUrl = 'https://mysparkplus.app/' + subRow.slug + '?reset=' + token;
      const agencyEmails = require('./lib/agency-emails');
      await agencyEmails.sendEmail(targetUser.email, 'password_reset_by_admin', {
        subName: subRow.name || subRow.slug,
        userName: targetUser.display_name || targetUser.username || 'there',
        resetUrl: resetUrl,
        resetByName: session.username || 'an administrator',
        subaccountId: subaccountId
      });
      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: session.user_id,
        actorUsername: session.username,
        actorRole: session.role,
        action: 'subaccount.user.password_reset_link_sent',
        targetType: 'subaccount_user',
        targetId: targetUser.id,
        targetSubaccountId: subaccountId,
        metadata: { target_email: targetUser.email }
      });
      return res.status(200).json({ success: true, magicLinkSent: true });
    } catch (e) {
      console.error('update-user: magic link only failed:', e.message);
      return res.status(500).json({ error: 'Failed to send reset link: ' + e.message });
    }
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
    // Email IS the username post-migration. Keep them in sync.
    if (patch.email) {
      patch.username = patch.email;
      changedFields.push('username');
    }
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
  if (color !== undefined && color !== targetUser.color) {
    patch.color = color;
    changedFields.push('color');
  }
  if (schedule !== undefined) {
    patch.schedule = schedule ? JSON.stringify(schedule) : null;
    changedFields.push('schedule');
  }
  if (dateOverrides !== undefined) {
    patch.date_overrides = dateOverrides ? JSON.stringify(dateOverrides) : null;
    changedFields.push('date_overrides');
  }
  if (isAgencyAdmin !== undefined && isAgencyAdmin !== null) {
    const newVal = !!isAgencyAdmin;
    if (newVal !== !!targetUser.is_agency_admin) {
      patch.is_agency_admin = newVal;
      changedFields.push('is_agency_admin');
    }
  }

  if (!changedFields.length) {
    return res.status(200).json({ success: true, noChange: true });
  }

  try {
    await db.update('subaccount_users', patch, { id: targetUser.id });
  } catch (e) {
    console.error('update-user: patch failed:', e.message);
    return res.status(500).json({ error: 'Update failed: ' + e.message });
  }

  // Revoke active sessions if role/active/password/is_agency_admin changed
  let sessionsRevoked = 0;
  if (changedFields.indexOf('role') >= 0 || changedFields.indexOf('active') >= 0 || changedFields.indexOf('password') >= 0 || changedFields.indexOf('is_agency_admin') >= 0) {
    try {
      const revoked = await db.update('sessions',
        { revoked_at: new Date().toISOString() },
        { user_id: targetUser.id, revoked_at: { op: 'is_null' } }
      );
      sessionsRevoked = revoked.length;
    } catch (e) {
      console.error('update-user: session revoke failed:', e.message);
    }
  }

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
      old_is_agency_admin: !!targetUser.is_agency_admin,
      new_is_agency_admin: patch.is_agency_admin !== undefined ? !!patch.is_agency_admin : !!targetUser.is_agency_admin,
      sessions_revoked: sessionsRevoked
    }
  });

  return res.status(200).json({
    success: true,
    sessionsRevoked: sessionsRevoked,
    changedFields: changedFields
  });
}

exports.handler = wrap(handler);
