// api/subaccount/login.js
// Server-side subaccount login with bcrypt password storage,
// dual-hash migration support, lockout, audit logging, and HttpOnly
// cookie session.
//
// Audit actions written:
//   subaccount.login.success      - successful auth
//   subaccount.login.failure      - bad credentials, inactive user, unknown user
//   subaccount.login.locked       - login attempted while account locked
//   subaccount.login.suspended    - subaccount itself is suspended (active=false)
//   subaccount.login.migration    - successful auth via legacy hash, rehashed to bcrypt
//   subaccount.login.breakglass   - emergency env var login used (LitBiz only)
//
// Failure logs include attempted username (for intrusion detection)
// but NEVER include the password or hash.

const { logAudit } = require('../../lib/audit');
const {
  hashPassword,
  verifyBcrypt,
  verifyLegacySha256,
  createSession,
  recordFailedLogin,
  clearFailedLogins,
  isLockedOut,
  getIpFromReq,
  getUserAgent,
  buildSessionCookie
} = require('../../lib/subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Break-glass admin for the LitBiz workspace only. Set on Vercel.
// If set, validates a single hardcoded admin login that always works
// regardless of database state. Uses the same SHA-256 hash as the
// legacy frontend for compatibility.
const SUBACCOUNT_FALLBACK_USER  = process.env.SUBACCOUNT_FALLBACK_USER;
const SUBACCOUNT_FALLBACK_HASH  = process.env.SUBACCOUNT_FALLBACK_HASH;
const SUBACCOUNT_FALLBACK_SLUG  = process.env.SUBACCOUNT_FALLBACK_SLUG || 'litbiz';

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

  const { slug, username, password } = req.body || {};

  if (!slug || !username || !password) {
    return res.status(400).json({ error: 'slug, username, and password are required' });
  }

  const normalizedUsername = String(username).trim().toLowerCase();
  const ipAddress = getIpFromReq(req);
  const userAgent = getUserAgent(req);

  // Resolve subaccount_id from slug
  let subaccountId = null;
  let subaccountActive = null;
  try {
    const subRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?slug=eq.' + encodeURIComponent(slug) + '&select=id,active,name',
      { headers: sbHeaders() }
    );
    if (subRes.ok) {
      const subRows = await subRes.json();
      if (subRows && subRows.length) {
        subaccountId = subRows[0].id;
        subaccountActive = subRows[0].active;
      }
    }
  } catch (e) {
    // Supabase unreachable. Fall through to break-glass check below.
  }

  // ============================================================
  // Lockout check (before doing any password work)
  // ============================================================
  if (subaccountId) {
    const lockState = await isLockedOut({
      subaccountId: subaccountId,
      username: normalizedUsername
    }).catch(function(){ return { locked: false }; });

    if (lockState.locked) {
      await logAudit({
        req,
        actorType: 'subaccount',
        actorUsername: normalizedUsername,
        action: 'subaccount.login.locked',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'denied',
        errorMessage: 'Account locked after too many failed attempts',
        metadata: {
          slug: slug,
          attempts: lockState.attempts,
          unlocks_at: lockState.unlocksAt
        }
      });
      return res.status(429).json({
        error: 'Too many failed attempts. Try again in ' + Math.ceil(lockState.retryAfterSeconds / 60) + ' minutes.',
        retry_after_seconds: lockState.retryAfterSeconds
      });
    }
  }

  // ============================================================
  // Subaccount suspension check (fail closed)
  // ============================================================
  if (subaccountActive === false) {
    await logAudit({
      req,
      actorType: 'subaccount',
      actorUsername: normalizedUsername,
      action: 'subaccount.login.suspended',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'denied',
      errorMessage: 'Subaccount is suspended',
      metadata: { slug: slug }
    });
    return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  }

  // ============================================================
  // Look up the user
  // ============================================================
  let user = null;
  if (subaccountId) {
    try {
      const userUrl = SUPABASE_URL + '/rest/v1/subaccount_users'
        + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
        + '&username=ilike.' + encodeURIComponent(normalizedUsername)
        + '&active=eq.true'
        + '&select=*';
      const userRes = await fetch(userUrl, { headers: sbHeaders() });
      if (userRes.ok) {
        const userRows = await userRes.json();
        if (userRows && userRows.length) user = userRows[0];
      }
    } catch (e) {
      // Continue to break-glass check
    }
  }

  // ============================================================
  // Break-glass admin (LitBiz workspace only, env vars must be set)
  // ============================================================
  if (!user
      && SUBACCOUNT_FALLBACK_USER
      && SUBACCOUNT_FALLBACK_HASH
      && slug === SUBACCOUNT_FALLBACK_SLUG
      && normalizedUsername === SUBACCOUNT_FALLBACK_USER.toLowerCase()) {

    if (verifyLegacySha256(password, SUBACCOUNT_FALLBACK_HASH)) {
      // Successful break-glass login. Issue a session as a synthetic admin user.
      // No DB user record; subaccount-side audit will note this is a break-glass session.
      const synthUserId = 'breakglass-' + slug;
      const sessionInfo = await createSession({
        userId: synthUserId,
        userType: 'subaccount',
        subaccountId: subaccountId || ('sub-' + slug),
        username: SUBACCOUNT_FALLBACK_USER,
        displayName: 'Break-Glass Admin',
        role: 'admin',
        ipAddress: ipAddress,
        userAgent: userAgent
      });

      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: synthUserId,
        actorUsername: SUBACCOUNT_FALLBACK_USER,
        actorRole: 'admin',
        action: 'subaccount.login.breakglass',
        targetType: 'subaccount',
        targetId: subaccountId || ('sub-' + slug),
        targetSubaccountId: subaccountId || ('sub-' + slug),
        metadata: { slug: slug, reason: 'env-var fallback used' }
      });

      res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.token));
      return res.status(200).json({
        success: true,
        user: {
          id: synthUserId,
          username: SUBACCOUNT_FALLBACK_USER,
          role: 'admin',
          name: 'Break-Glass Admin',
          breakglass: true
        },
        expires_at: sessionInfo.expiresAt
      });
    }
  }

  // ============================================================
  // No user found - generic failure (do not leak whether user exists)
  // ============================================================
  if (!user) {
    if (subaccountId) {
      await recordFailedLogin({
        subaccountId: subaccountId,
        username: normalizedUsername,
        ipAddress: ipAddress,
        userAgent: userAgent,
        userType: 'subaccount'
      });
    }
    await logAudit({
      req,
      actorType: 'subaccount',
      actorUsername: normalizedUsername,
      action: 'subaccount.login.failure',
      targetType: 'subaccount',
      targetId: subaccountId || null,
      targetSubaccountId: subaccountId || null,
      outcome: 'failure',
      errorMessage: 'Unknown user or workspace',
      metadata: { slug: slug, reason: 'user_not_found' }
    });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // ============================================================
  // Verify password (bcrypt first, fall back to legacy SHA-256)
  // ============================================================
  let validPassword = false;
  let migrated = false;

  if (user.password_hash) {
    validPassword = await verifyBcrypt(password, user.password_hash);
  }

  if (!validPassword && user.legacy_password_hash) {
    if (verifyLegacySha256(password, user.legacy_password_hash)) {
      validPassword = true;
      migrated = true;
      // Rehash to bcrypt and persist (best-effort, don't block login)
      try {
        const newHash = await hashPassword(password);
        await fetch(SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + user.id, {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({
            password_hash: newHash,
            legacy_password_hash: null,
            password_changed_at: new Date().toISOString()
          })
        });
      } catch (e) {
        console.error('login: bcrypt migration failed for user', user.id, e.message);
      }
    }
  }

  if (!validPassword) {
    await recordFailedLogin({
      subaccountId: subaccountId,
      username: normalizedUsername,
      ipAddress: ipAddress,
      userAgent: userAgent,
      userType: 'subaccount'
    });
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      action: 'subaccount.login.failure',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: 'Invalid password',
      metadata: { slug: slug, reason: 'bad_password' }
    });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // ============================================================
  // Success: clear failed attempts, create session, issue cookie
  // ============================================================
  await clearFailedLogins({
    subaccountId: subaccountId,
    username: normalizedUsername
  }).catch(function(){});

  const sessionInfo = await createSession({
    userId: user.id,
    userType: 'subaccount',
    subaccountId: subaccountId,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    ipAddress: ipAddress,
    userAgent: userAgent
  });

  // Update last_login_at (best-effort)
  fetch(SUPABASE_URL + '/rest/v1/subaccount_users?id=eq.' + user.id, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({ last_login_at: new Date().toISOString() })
  }).catch(function(){});

  // Audit success
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: user.id,
    actorUsername: user.username,
    actorRole: user.role,
    action: migrated ? 'subaccount.login.migration' : 'subaccount.login.success',
    targetType: 'subaccount',
    targetId: subaccountId,
    targetSubaccountId: subaccountId,
    metadata: {
      slug: slug,
      migrated_from_sha256: migrated || undefined,
      session_id: sessionInfo.sessionId
    }
  });

  res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.token));
  return res.status(200).json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.display_name || user.username,
      color: user.color,
      email: user.email,
      must_change_password: !!user.must_change_password
    },
    expires_at: sessionInfo.expiresAt
  });
};
