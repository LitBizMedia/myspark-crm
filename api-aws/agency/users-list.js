// api/agency/users-list.js (Lambda version)
//
// GET /api/agency/users-list
//
// Super_admin agency tool. Returns every active subaccount user across all
// subaccounts, with name, email, role, owning subaccount, password-reset
// state, and EULA acceptance status against the currently active EULA version.
//
// Guarded by requireAgencyAdmin (same guard as login-as and subaccounts-list).
// Read-only. Audit-logged as a bulk agency read.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  try {
    // Active EULA version (may be none until Pass 2 seeds one).
    const av = await db.query(
      `SELECT version FROM eula_versions WHERE active = TRUE LIMIT 1`
    );
    const activeVersion = av.rows[0] ? av.rows[0].version : null;

    // All active users joined to their subaccount, with acceptance of the
    // active version resolved in one pass. When activeVersion is null, the
    // acceptance join matches nothing and every user reads not-accepted.
    const r = await db.query(
      `SELECT
         u.id,
         u.subaccount_id,
         u.username,
         u.display_name,
         u.email,
         u.role,
         u.must_change_password,
         u.created_at,
         s.name AS subaccount_name,
         s.slug AS subaccount_slug,
         (a.id IS NOT NULL) AS eula_accepted,
         a.accepted_at      AS eula_accepted_at
       FROM subaccount_users u
       JOIN subaccounts s ON s.id = u.subaccount_id
       LEFT JOIN eula_acceptances a
         ON a.user_id = u.id AND a.eula_version = $1
       WHERE u.active = true
       ORDER BY s.name ASC, u.display_name ASC, u.username ASC`,
      [activeVersion]
    );

    const users = r.rows.map(row => ({
      id: row.id,
      subaccountId: row.subaccount_id,
      subaccountName: row.subaccount_name,
      subaccountSlug: row.subaccount_slug,
      name: row.display_name || row.username || '(no name)',
      email: row.email || '',
      role: row.role || '',
      mustChangePassword: !!row.must_change_password,
      eulaAccepted: !!row.eula_accepted,
      eulaAcceptedAt: row.eula_accepted_at || null,
      createdAt: row.created_at
    }));

    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.users.list',
      metadata: { user_count: users.length, active_eula_version: activeVersion }
    });

    return res.status(200).json({
      users: users,
      active_eula_version: activeVersion,
      total: users.length
    });
  } catch (e) {
    console.error('users-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load users' });
  }
}

exports.handler = wrap(handler);
