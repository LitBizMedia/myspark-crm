// api/subaccount/login.js (Lambda version)
// 
// POST /api/subaccount/login
//
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
// MIGRATED: Supabase REST → lib/db.js for subaccounts and subaccount_users queries.

const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
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
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

// Break-glass admin for the LitBiz workspace only. Set via Lambda env vars.
const SUBACCOUNT_FALLBACK_USER  = process.env.SUBACCOUNT_FALLBACK_USER;
const SUBACCOUNT_FALLBACK_HASH  = process.env.SUBACCOUNT_FALLBACK_HASH;
const SUBACCOUNT_FALLBACK_SLUG  = process.env.SUBACCOUNT_FALLBACK_SLUG || 'litbiz';

async function handler(req, res) {
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
    const sub = await db.findOne('subaccounts',
      { slug: slug },
      { select: 'id, active, name' }
    );
    if (sub) {
      subaccountId = sub.id;
      subaccountActive = sub.active;
    }
  } catch (e) {
    console.error('login: subaccount lookup failed:', e.message);
    // Fall through to break-glass check below.
  }

  // ============================================================
  // Lockout check
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
  // Look up the user (case-insensitive username, must be active)
  // ============================================================
  let user = null;
  if (subaccountId) {
    try {
      // ILIKE on username for case-insensitive match
      const userRows = await db.query(
        `SELECT * FROM subaccount_users
         WHERE subaccount_id = $1
           AND username ILIKE $2
           AND active = true
         LIMIT 1`,
        [subaccountId, normalizedUsername]
      );
      if (userRows.rows && userRows.rows.length) {
        user = userRows.rows[0];
      }
    } catch (e) {
      console.error('login: user lookup failed:', e.message);
    }
  }

  // ============================================================
  // Break-glass admin (LitBiz workspace only)
  // ============================================================
  if (!user
      && SUBACCOUNT_FALLBACK_USER
      && SUBACCOUNT_FALLBACK_HASH
      && slug === SUBACCOUNT_FALLBACK_SLUG
      && normalizedUsername === SUBACCOUNT_FALLBACK_USER.toLowerCase()) {

    if (verifyLegacySha256(password, SUBACCOUNT_FALLBACK_HASH)) {
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
  // No user found - generic failure
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
      // Rehash to bcrypt and persist (best-effort)
      try {
        const newHash = await hashPassword(password);
        await db.update('subaccount_users',
          {
            password_hash: newHash,
            legacy_password_hash: null,
            password_changed_at: new Date().toISOString()
          },
          { id: user.id }
        );
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

  // Update last_login_at (best-effort, fire-and-forget)
  db.update('subaccount_users',
    { last_login_at: new Date().toISOString() },
    { id: user.id }
  ).catch(function(){});

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
}

exports.handler = wrap(handler);
