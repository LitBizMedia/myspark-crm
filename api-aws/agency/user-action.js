// api/agency/user-action.js (Lambda version)
//
// POST /api/agency/user-action
// Body: { action: 'send_reset' | 'unflag', userId: '<uuid>' }
//
// Super_admin agency tool. Per-user actions from the Users panel:
//   send_reset → mint a password reset token, email the user a reset link
//                (reuses the password_reset_by_admin template + token table
//                 mechanics from reset-subaccount-password.js, generalized to
//                 any user by id rather than the subaccount admin by username).
//   unflag     → delete the user's EULA acceptance rows so they re-prompt on
//                their next real login. Cleanup for test-as-user accidents.
//
// Guarded by requireAgencyAdmin. Both actions audit-logged.

const db = require('./lib/db');
const crypto = require('crypto');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const agencyEmails = require('./lib/agency-emails');
const { wrap } = require('./lib/lambda-adapter');

const RESET_TTL_MS = 60 * 60 * 1000; // 60 minutes

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { action, userId } = req.body || {};
  if (!action || !userId) return res.status(400).json({ error: 'action and userId required' });
  if (['send_reset', 'unflag'].indexOf(action) < 0) {
    return res.status(400).json({ error: 'action must be send_reset or unflag' });
  }

  // Resolve the target user + owning subaccount slug/name.
  let target;
  try {
    const r = await db.query(
      `SELECT u.id, u.subaccount_id, u.username, u.display_name, u.email,
              s.slug AS subaccount_slug, s.name AS subaccount_name
       FROM subaccount_users u
       JOIN subaccounts s ON s.id = u.subaccount_id
       WHERE u.id = $1 AND u.active = true
       LIMIT 1`,
      [userId]
    );
    target = r.rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'User lookup failed: ' + e.message });
  }
  if (!target) return res.status(404).json({ error: 'User not found' });

  // ── send_reset ──
  if (action === 'send_reset') {
    if (!target.email) {
      return res.status(400).json({ error: 'User has no email on file. Cannot send reset link.' });
    }
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
      await db.insertOne('password_reset_tokens', {
        token: token,
        user_type: 'subaccount_user',
        user_identifier: target.id,
        subaccount_slug: target.subaccount_slug,
        email: target.email,
        expires_at: expiresAt
      });
      const resetUrl = 'https://mysparkplus.app/' + target.subaccount_slug + '?reset=' + token;
      await agencyEmails.sendEmail(target.email, 'password_reset_by_admin', {
        subName: target.subaccount_name || target.subaccount_slug,
        userName: target.display_name || target.username || 'there',
        resetUrl: resetUrl,
        resetByName: auth.username || 'an administrator',
        subaccountId: target.subaccount_id
      });
      await logAudit({
        req,
        actorType: 'agency_admin',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: 'agency.user.password_reset_link_sent',
        targetType: 'subaccount_user',
        targetId: target.id,
        targetSubaccountId: target.subaccount_id,
        metadata: { subaccount_slug: target.subaccount_slug, target_email: target.email }
      });
      return res.status(200).json({ success: true, action: 'send_reset', email: target.email });
    } catch (e) {
      console.error('user-action send_reset failed:', e.message);
      return res.status(500).json({ error: 'Failed to send reset link: ' + e.message });
    }
  }

  // ── unflag ──
  if (action === 'unflag') {
    try {
      const del = await db.query(
        `DELETE FROM eula_acceptances WHERE user_id = $1`,
        [target.id]
      );
      const removed = del.rowCount || 0;
      await logAudit({
        req,
        actorType: 'agency_admin',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: 'agency.user.eula_unflag',
        targetType: 'subaccount_user',
        targetId: target.id,
        targetSubaccountId: target.subaccount_id,
        metadata: { subaccount_slug: target.subaccount_slug, acceptances_removed: removed }
      });
      return res.status(200).json({ success: true, action: 'unflag', acceptances_removed: removed });
    } catch (e) {
      console.error('user-action unflag failed:', e.message);
      return res.status(500).json({ error: 'Failed to unflag user: ' + e.message });
    }
  }
}

exports.handler = wrap(handler);
