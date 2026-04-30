// api/agency/users-update.js (Lambda version)
// POST /api/agency/users-update
// Updates an agency user. Includes safety guards for last super admin
// and self-edit password verification.

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

  const auth = await requireAgencyAuth(req, res, { requireRole: ['super_admin', 'admin'] });
  if (!auth) return;

  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: 'id required' });

  try {
    // Last super admin guard
    if (b.role && b.role !== 'super_admin') {
      const all = await db.query('SELECT id, role, active FROM agency_users');
      const target = all.rows.find(u => u.id === b.id);
      if (target && target.role === 'super_admin') {
        const activeSuperAdmins = all.rows.filter(u => u.role === 'super_admin' && u.active !== false).length;
        if (activeSuperAdmins <= 1) {
          return res.status(400).json({ error: 'Cannot change role of the last active Super Admin' });
        }
      }
    }

    // Self-edit password verification
    let newHash = null;
    if (b.password) {
      const passErr = checkPasswordStrength(b.password);
      if (passErr) return res.status(400).json({ error: passErr });

      const isSelfEdit = b.id === auth.user_id;
      if (isSelfEdit) {
        if (!b.currentPassword) return res.status(400).json({ error: 'Current password required for self-edit' });
        const oldHash = sha256(b.currentPassword);
        const verify = await db.query('SELECT password_hash FROM agency_users WHERE id = $1', [b.id]);
        if (verify.rows.length === 0 || verify.rows[0].password_hash !== oldHash) {
          return res.status(403).json({ error: 'Current password is incorrect' });
        }
      }
      newHash = sha256(b.password);
    }

    // Build update SET clause
    const sets = [];
    const params = [b.id];
    let p = 2;
    if (b.name !== undefined) { sets.push(`name = $${p++}`); params.push(b.name); }
    if (b.email !== undefined) { sets.push(`email = $${p++}`); params.push(b.email.toLowerCase().trim()); }
    if (b.role !== undefined) { sets.push(`role = $${p++}`); params.push(b.role); }
    if (b.active !== undefined) { sets.push(`active = $${p++}`); params.push(!!b.active); }
    if (newHash) { sets.push(`password_hash = $${p++}`); params.push(newHash); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');

    const r = await db.query(
      `UPDATE agency_users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, name, role, active`,
      params
    );

    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.user.update',
      targetType: 'agency_user',
      targetId: b.id,
      metadata: {
        name_changed: b.name !== undefined,
        role_changed: b.role !== undefined,
        active_changed: b.active !== undefined,
        password_changed: !!newHash,
        is_self: b.id === auth.user_id
      }
    });

    return res.status(200).json({ user: r.rows[0] });
  } catch (e) {
    console.error('users-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update user' });
  }
}

exports.handler = wrap(handler);
