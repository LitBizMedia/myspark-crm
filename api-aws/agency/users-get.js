// api/agency/users-get.js (Lambda version)
// GET /api/agency/users-get?id=X
// Returns one agency user (excluding password hash).

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  const { id } = req.query || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const r = await db.query(
      'SELECT id, username, name, email, role, active, created_at, updated_at FROM agency_users WHERE id = $1',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json({ user: r.rows[0] });
  } catch (e) {
    console.error('users-get error:', e.message);
    return res.status(500).json({ error: 'Failed to load user' });
  }
}

exports.handler = wrap(handler);
