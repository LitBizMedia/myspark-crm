// api/agency/users-create.js (Lambda version)
// POST /api/agency/users-create
// Creates a new agency user. Super admin or admin role required.

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
  if (!b.id || !b.username || !b.name || !b.email || !b.password) {
    return res.status(400).json({ error: 'id, username, name, email, password all required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return res.status(400).json({ error: 'Invalid email' });

  const passErr = checkPasswordStrength(b.password);
  if (passErr) return res.status(400).json({ error: passErr });

  const username = b.username.toLowerCase().trim();

  try {
    // Username uniqueness
    const existing = await db.query('SELECT id FROM agency_users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Username already exists' });

    const hash = sha256(b.password);
    const role = b.role || 'admin';

    await db.query(`
      INSERT INTO agency_users (id, username, password_hash, name, email, role, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
    `, [b.id, username, hash, b.name, b.email.toLowerCase().trim(), role]);

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.user.create',
      targetType: 'agency_user',
      targetId: b.id,
      metadata: { username, name: b.name, role }
    });

    return res.status(200).json({ success: true, id: b.id });
  } catch (e) {
    console.error('users-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create user' });
  }
}

exports.handler = wrap(handler);
