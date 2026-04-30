// api/agency/users-list.js (Lambda version)
// GET /api/agency/users-list
// Returns all agency users (excluding password hashes) ordered by created_at.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  try {
    const r = await db.query(
      'SELECT id, username, name, email, role, active, created_at, updated_at FROM agency_users ORDER BY created_at ASC'
    );
    return res.status(200).json({ users: r.rows });
  } catch (e) {
    console.error('users-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load users' });
  }
}

exports.handler = wrap(handler);
