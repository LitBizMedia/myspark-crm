// api/agency/users-delete.js (Lambda version)
// POST /api/agency/users-delete
// Deletes an agency user. Includes last super admin guard.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  if (id === auth.user_id) return res.status(400).json({ error: 'Cannot delete yourself' });

  try {
    // Last super admin guard
    const all = await db.query('SELECT id, role, active FROM agency_users');
    const target = all.rows.find(u => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'super_admin') {
      const activeSuperAdmins = all.rows.filter(u => u.role === 'super_admin' && u.active !== false).length;
      if (activeSuperAdmins <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active Super Admin' });
      }
    }

    await db.query('DELETE FROM agency_users WHERE id = $1', [id]);

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.user.delete',
      targetType: 'agency_user',
      targetId: id,
      metadata: { deleted_role: target.role }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('users-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
}

exports.handler = wrap(handler);
