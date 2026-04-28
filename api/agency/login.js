// api/agency/login.js
// Server-side agency login with audit logging.
//
// Validates credentials against agency_users in Supabase. Falls back to
// hardcoded disaster-recovery credentials only if Supabase is unreachable.
//
// Logs every login attempt:
//   agency.login.success - successful auth
//   agency.login.failure - bad credentials, inactive user, or other rejection
//
// Failure logs include the attempted username (HIPAA intrusion detection),
// never the password or hash.

const { logAudit } = require('../../lib/audit');
const {
  createSession,
  buildSessionCookie,
  getIpFromReq,
  getUserAgent
} = require('../../lib/subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AGENCY_FALLBACK_USER = process.env.AGENCY_FALLBACK_USER;
const AGENCY_FALLBACK_HASH = process.env.AGENCY_FALLBACK_HASH;

function sbHeaders() {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, hash } = req.body || {};
  if (!username || !hash) {
    return res.status(400).json({ error: 'Username and hash required' });
  }

  const normalizedUsername = String(username).trim().toLowerCase();

  // ─────────────────────────────────────────────
  // Try Supabase first
  // ─────────────────────────────────────────────
  let dbReachable = false;
  try {
    const dbRes = await fetch(
      SUPABASE_URL + '/rest/v1/agency_users'
        + '?username=eq.' + encodeURIComponent(normalizedUsername)
        + '&active=eq.true'
        + '&select=*',
      { headers: sbHeaders() }
    );

    if (dbRes.ok) {
      dbReachable = true;
      const rows = await dbRes.json();

      if (rows && rows.length && rows[0].password_hash === hash) {
        const u = rows[0];
        const user = {
          id:       u.id,
          username: u.username,
          name:     u.name || u.username,
          role:     u.role || 'admin'
        };

        // Create server-side session and set HttpOnly cookie
        let sessionInfo = null;
        try {
          sessionInfo = await createSession({
            userId:       user.id,
            userType:     'agency',
            subaccountId: null,
            username:     user.username,
            displayName:  user.name,
            role:         user.role,
            ipAddress:    getIpFromReq(req),
            userAgent:    getUserAgent(req)
          });
          res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.token));
        } catch (sessErr) {
          console.error('agency login: failed to create server session:', sessErr.message);
          // Continue with login; legacy localStorage path still works
        }

        await logAudit({
          req,
          actorType:     'agency',
          actorId:       user.id,
          actorUsername: user.username,
          actorRole:     user.role,
          action:        'agency.login.success',
          targetType:    'agency_user',
          targetId:      user.id,
          metadata:      {
            source: 'database',
            session_id: sessionInfo && sessionInfo.sessionId
          }
        });

        return res.status(200).json({ success: true, user: user });
      }

      // DB reachable but no match. Do not fall back. Log and reject.
      await logAudit({
        req,
        actorType:     'agency',
        actorUsername: normalizedUsername,
        action:        'agency.login.failure',
        outcome:       'failure',
        errorMessage:  'Invalid credentials',
        metadata:      { source: 'database', reason: 'no_match_or_password_mismatch' }
      });
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    console.warn('agency login: DB returned non-OK status:', dbRes.status);
  } catch (e) {
    console.warn('agency login: DB unreachable, trying fallback:', e.message);
  }

  // ─────────────────────────────────────────────
  // Fallback for disaster recovery (DB unreachable only)
  // ─────────────────────────────────────────────
  if (AGENCY_FALLBACK_USER && AGENCY_FALLBACK_HASH
      && normalizedUsername === AGENCY_FALLBACK_USER
      && hash === AGENCY_FALLBACK_HASH) {

    const user = {
      id:       'agency-admin-primary',
      username: AGENCY_FALLBACK_USER,
      name:     'Admin',
      role:     'super_admin'
    };

    // Create server-side session and set HttpOnly cookie (best effort)
    let sessionInfo = null;
    try {
      sessionInfo = await createSession({
        userId:       user.id,
        userType:     'agency',
        subaccountId: null,
        username:     user.username,
        displayName:  user.name,
        role:         user.role,
        ipAddress:    getIpFromReq(req),
        userAgent:    getUserAgent(req)
      });
      res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.token));
    } catch (sessErr) {
      console.error('agency login (fallback): failed to create server session:', sessErr.message);
      // Continue with login; legacy localStorage path still works
    }

    await logAudit({
      req,
      actorType:     'agency',
      actorId:       'agency-admin-primary',
      actorUsername: AGENCY_FALLBACK_USER,
      actorRole:     'super_admin',
      action:        'agency.login.success',
      metadata:      {
        source: 'fallback',
        warning: 'database_unreachable',
        session_id: sessionInfo && sessionInfo.sessionId
      }
    });

    return res.status(200).json({ success: true, user: user });
  }

  // No match anywhere
  await logAudit({
    req,
    actorType:     'agency',
    actorUsername: normalizedUsername,
    action:        'agency.login.failure',
    outcome:       'failure',
    errorMessage:  'Invalid credentials',
    metadata:      { source: dbReachable ? 'database' : 'fallback_unavailable' }
  });
  return res.status(401).json({ success: false, error: 'Invalid credentials' });
};
