// api/agency/subaccount-admin-update.js (Lambda version)
//
// POST /api/agency/subaccount-admin-update
//
// Updates the primary admin user of a subaccount. Used by the agency
// dashboard's Edit Subaccount modal.
//
// Updatable fields: username, display_name, email, color
// Password resets go through reset-subaccount-password; this is rename only.
//
// Auth: super_admin required.
//
// All updates run in a single transaction:
//   1. Update subaccount_users row
//   2. If username changed, also update subaccounts.admin_username
//
// Audit logged.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const b = req.body || {};
  if (!b.subaccountId) return res.status(400).json({ error: 'subaccountId required' });

  const subaccountId = b.subaccountId;

  // Build the patch object (only fields the caller actually provided).
  const patch = {};
  if (typeof b.newUsername === 'string') {
    const cleaned = b.newUsername.trim().toLowerCase();
    if (!cleaned) return res.status(400).json({ error: 'newUsername cannot be empty' });
    if (!/^[a-z0-9_.-]+$/.test(cleaned)) {
      return res.status(400).json({ error: 'username can only contain lowercase letters, numbers, dot, dash, underscore' });
    }
    patch.username = cleaned;
  }
  if (typeof b.newDisplayName === 'string') {
    patch.display_name = b.newDisplayName.trim();
  }
  if (typeof b.newEmail === 'string') {
    const cleaned = b.newEmail.trim().toLowerCase();
    if (cleaned && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
      return res.status(400).json({ error: 'newEmail is not a valid email address' });
    }
    patch.email = cleaned || null;
  }
  if (typeof b.newColor === 'string') {
    patch.color = b.newColor;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  // Look up the subaccount + current admin
  let sub;
  try {
    sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'id, slug, name, admin_username, admin_email' }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load subaccount: ' + e.message });
  }
  if (!sub) return res.status(404).json({ error: 'Subaccount not found' });
  if (!sub.admin_username) {
    return res.status(400).json({ error: 'Subaccount has no admin_username on record. Use reset-subaccount-password first to provision one.' });
  }

  // Find the existing admin row
  let user = null;
  try {
    const r = await db.query(
      `SELECT id, username, display_name, email, color
       FROM subaccount_users
       WHERE subaccount_id = $1 AND username ILIKE $2
       LIMIT 1`,
      [subaccountId, sub.admin_username]
    );
    user = r.rows[0] || null;
  } catch (e) {
    return res.status(500).json({ error: 'User lookup failed: ' + e.message });
  }
  if (!user) {
    return res.status(404).json({ error: 'Admin user row not found in subaccount_users. Use reset-subaccount-password to provision.' });
  }

  // If username is changing, check it isn't taken by another user in this subaccount
  if (patch.username && patch.username !== user.username.toLowerCase()) {
    try {
      const conflict = await db.query(
        `SELECT id FROM subaccount_users
         WHERE subaccount_id = $1 AND username ILIKE $2 AND id != $3
         LIMIT 1`,
        [subaccountId, patch.username, user.id]
      );
      if (conflict.rows.length > 0) {
        return res.status(409).json({ error: 'Username "' + patch.username + '" is already taken in this workspace.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Username conflict check failed: ' + e.message });
    }
  }

  // Run updates in a transaction
  const usernameChanged = patch.username && patch.username !== user.username.toLowerCase();
  const emailChanged = ('email' in patch) && patch.email !== (user.email || null);

  try {
    await db.transaction(async (client) => {
      // 1. Update subaccount_users
      const setParts = [];
      const params = [];
      let i = 1;
      for (const [col, val] of Object.entries(patch)) {
        setParts.push(col + ' = $' + i);
        params.push(val);
        i++;
      }
      setParts.push('updated_at = NOW()');
      params.push(user.id);
      await client.query(
        `UPDATE subaccount_users SET ${setParts.join(', ')} WHERE id = $${i}`,
        params
      );

      // 2. If username changed, sync subaccounts.admin_username
      if (usernameChanged) {
        await client.query(
          `UPDATE subaccounts SET admin_username = $1 WHERE id = $2`,
          [patch.username, subaccountId]
        );
      }

      // 3. If email changed, sync subaccounts.admin_email too
      if (emailChanged) {
        await client.query(
          `UPDATE subaccounts SET admin_email = $1 WHERE id = $2`,
          [patch.email, subaccountId]
        );
      }
    });
  } catch (e) {
    console.error('subaccount-admin-update error:', e.message);
    return res.status(500).json({ error: 'Update failed: ' + e.message });
  }

  await logAudit({
    req,
    actorType: 'agency_admin',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'agency.subaccount.admin_update',
    targetType: 'subaccount_user',
    targetId: user.id,
    targetSubaccountId: subaccountId,
    metadata: {
      subaccount_slug: sub.slug,
      subaccount_name: sub.name,
      changes: Object.keys(patch),
      old_username: user.username,
      new_username: patch.username || user.username,
      username_changed: usernameChanged,
      email_changed: emailChanged
    }
  });

  return res.status(200).json({
    success: true,
    user_id: user.id,
    username_changed: usernameChanged,
    email_changed: emailChanged
  });
}

exports.handler = wrap(handler);
