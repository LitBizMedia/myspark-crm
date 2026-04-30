// api/agency/login.js (Lambda version)
//
// POST /api/agency/login
//
// Server-side agency login with audit logging.
// Validates credentials against agency_users. Falls back to hardcoded
// disaster-recovery credentials only if DB unreachable.
//
// MIGRATED: Supabase REST → lib/db.js for agency_users lookup.

const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
const {
  createSession,
  buildAgencySessionCookie,
  getIpFromReq,
  getUserAgent
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

const AGENCY_FALLBACK_USER = process.env.AGENCY_FALLBACK_USER;
const AGENCY_FALLBACK_HASH = process.env.AGENCY_FALLBACK_HASH;

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, hash } = req.body || {};
  if (!username || !hash) {
    return res.status(400).json({ error: 'Username and hash required' });
  }

  const normalizedUsername = String(username).trim().toLowerCase();

  // ─────────────────────────────────────────────
  // Try database first
  // ─────────────────────────────────────────────
  let dbReachable = false;
  try {
    const u = await db.findOne('agency_users', {
      username: normalizedUsername,
      active: true
    });
    
    dbReachable = true;
    
    if (u && u.password_hash === hash) {
      const user = {
        id:       u.id,
        username: u.username,
        name:     u.name || u.username,
        role:     u.role || 'admin'
      };

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
        res.setHeader('Set-Cookie', buildAgencySessionCookie(sessionInfo.token));
      } catch (sessErr) {
        console.error('agency login: failed to create server session:', sessErr.message);
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

    // DB reachable but no match
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

  } catch (e) {
    console.warn('agency login: DB unreachable, trying fallback:', e.message);
  }

  // ─────────────────────────────────────────────
  // Fallback for disaster recovery
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
      res.setHeader('Set-Cookie', buildAgencySessionCookie(sessionInfo.token));
    } catch (sessErr) {
      console.error('agency login (fallback): failed to create server session:', sessErr.message);
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
}

exports.handler = wrap(handler);
