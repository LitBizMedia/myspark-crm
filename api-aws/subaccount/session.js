// api/subaccount/session.js (Lambda version)
//
// GET /api/subaccount/session
//
// Returns the current session info if the cookie is valid.
// Used by the frontend on page load to validate a stored session
// before allowing access to the app.
//
// Phase 11 (Path A): Extended to include subaccount.active and
// subaccount_plans.hipaa_addon so frontend doesn't need direct Supabase reads.

const db = require('./lib/db');
const {
  parseSessionCookie,
  validateSession,
  buildClearCookie
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'No session cookie', authenticated: false });
  }

  const session = await validateSession(token);
  if (!session) {
    res.setHeader('Set-Cookie', buildClearCookie());
    return res.status(401).json({ error: 'Invalid or expired session', authenticated: false });
  }

  // Look up subaccount status (active flag) and HIPAA addon status
  let subaccountActive = null;
  let hipaaAddon = false;
  let subaccountName = null;
  let subaccountSlug = null;
  let isAgencyAdmin = false;
  try {
    const subResult = await db.query(
      'SELECT name, slug, active FROM subaccounts WHERE id = $1 LIMIT 1',
      [session.subaccount_id]
    );
    if (subResult.rows.length > 0) {
      subaccountActive = subResult.rows[0].active !== false;
      subaccountName = subResult.rows[0].name || null;
      subaccountSlug = subResult.rows[0].slug || null;
    }

    const planResult = await db.query(
      'SELECT hipaa_addon FROM subaccount_plans WHERE subaccount_id = $1 LIMIT 1',
      [session.subaccount_id]
    );
    if (planResult.rows.length > 0) {
      hipaaAddon = !!planResult.rows[0].hipaa_addon;
    }

    // Look up is_agency_admin for the calling user. Live DB read so revocation
    // takes effect on next session check, no waiting for session expiry.
    if (session.user_type === 'subaccount' && session.user_id) {
      const userResult = await db.query(
        'SELECT is_agency_admin FROM subaccount_users WHERE id = $1 LIMIT 1',
        [session.user_id]
      );
      if (userResult.rows.length > 0) {
        isAgencyAdmin = !!userResult.rows[0].is_agency_admin;
      }
    }
  } catch (e) {
    console.error('session: status lookup failed:', e.message);
    // Don't fail the session on status lookup error - just leave fields null
  }

  return res.status(200).json({
    authenticated: true,
    user: {
      id: session.user_id,
      username: session.username,
      role: session.role,
      name: session.display_name || session.username,
      type: session.user_type,
      subaccount_id: session.subaccount_id,
      is_agency_admin: isAgencyAdmin
    },
    subaccount: {
      id: session.subaccount_id,
      name: subaccountName,
      slug: subaccountSlug,
      active: subaccountActive,
      hipaa_addon: hipaaAddon
    },
    expires_at: session.expires_at
  });
}

exports.handler = wrap(handler);
