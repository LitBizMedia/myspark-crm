// lib/subaccount-auth.js
// Server-side authentication helpers for subaccount login.
// 
// Uses bcrypt for password storage and crypto.randomBytes for session tokens.
// 
// MIGRATED from Supabase REST fetch to direct pg queries via lib/db.js.
// Behavior is identical to the previous version - only the database backend changed.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Lockout configuration
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Session configuration
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

// ============================================================
// Password hashing (unchanged - no DB calls)
// ============================================================

async function hashPassword(plaintext) {
  return await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

async function verifyBcrypt(plaintext, hash) {
  if (!plaintext || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch (e) {
    return false;
  }
}

function verifyLegacySha256(plaintext, legacyHash) {
  if (!plaintext || !legacyHash) return false;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return hash === legacyHash;
}

// ============================================================
// Session tokens
// ============================================================

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(opts) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  const row = {
    token_hash: tokenHash,
    user_id: opts.userId,
    user_type: opts.userType,
    subaccount_id: opts.subaccountId || null,
    username: opts.username,
    display_name: opts.displayName || opts.username,
    role: opts.role || null,
    ip_address: opts.ipAddress || null,
    user_agent: opts.userAgent ? String(opts.userAgent).slice(0, 500) : null,
    expires_at: expiresAt
  };

  let created;
  try {
    created = await db.insertOne('sessions', row);
  } catch (err) {
    throw new Error('Failed to create session: ' + err.message);
  }

  return {
    token: token,
    sessionId: created && created.id,
    expiresAt: expiresAt
  };
}

async function validateSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  
  let session;
  try {
    session = await db.findOne('sessions', { token_hash: tokenHash });
  } catch (err) {
    console.error('[auth] validateSession error:', err.message);
    return null;
  }
  
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  // Touch last_used_at (best-effort, don't block on this)
  db.update('sessions', { last_used_at: new Date().toISOString() }, { id: session.id })
    .catch(function(){});

  return session;
}

async function revokeSession(token, reason) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  try {
    const updated = await db.update('sessions',
      { revoked_at: new Date().toISOString(), revoked_reason: reason || 'logout' },
      { token_hash: tokenHash }
    );
    return updated.length > 0;
  } catch (err) {
    console.error('[auth] revokeSession error:', err.message);
    return false;
  }
}

async function revokeAllUserSessions(userId, userType, reason) {
  try {
    await db.update('sessions',
      { revoked_at: new Date().toISOString(), revoked_reason: reason || 'revoked' },
      { user_id: userId, user_type: userType, revoked_at: { op: 'is_null' } }
    );
    return true;
  } catch (err) {
    console.error('[auth] revokeAllUserSessions error:', err.message);
    return false;
  }
}

// ============================================================
// Failed login tracking and lockout
// ============================================================

async function recordFailedLogin(opts) {
  const row = {
    subaccount_id: opts.subaccountId || null,
    username: opts.username || '',
    user_type: opts.userType || 'subaccount',
    ip_address: opts.ipAddress || null,
    user_agent: opts.userAgent ? String(opts.userAgent).slice(0, 500) : null
  };
  try {
    await db.insertOne('failed_login_attempts', row);
  } catch (err) {
    console.error('[auth] recordFailedLogin error:', err.message);
  }
}

async function clearFailedLogins(opts) {
  const filters = { username: { op: 'ilike', value: opts.username } };
  if (opts.subaccountId) {
    filters.subaccount_id = opts.subaccountId;
  } else {
    filters.subaccount_id = { op: 'is_null' };
  }
  try {
    await db.deleteWhere('failed_login_attempts', filters);
  } catch (err) {
    console.error('[auth] clearFailedLogins error:', err.message);
  }
}

async function isLockedOut(opts) {
  const cutoff = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();
  const filters = {
    username: { op: 'ilike', value: opts.username },
    attempted_at: { op: 'gte', value: cutoff }
  };
  if (opts.subaccountId) {
    filters.subaccount_id = opts.subaccountId;
  } else {
    filters.subaccount_id = { op: 'is_null' };
  }
  
  let rows;
  try {
    rows = await db.findMany('failed_login_attempts', filters, {
      select: 'attempted_at',
      orderBy: { col: 'attempted_at', asc: false },
      limit: LOCKOUT_THRESHOLD + 1
    });
  } catch (err) {
    console.error('[auth] isLockedOut error:', err.message);
    return { locked: false, attempts: 0 };
  }
  
  const attempts = (rows || []).length;
  if (attempts < LOCKOUT_THRESHOLD) return { locked: false, attempts: attempts };

  const mostRecent = new Date(rows[0].attempted_at);
  const lockoutEndsAt = new Date(mostRecent.getTime() + LOCKOUT_DURATION_MS);
  if (lockoutEndsAt > new Date()) {
    return {
      locked: true,
      attempts: attempts,
      unlocksAt: lockoutEndsAt.toISOString(),
      retryAfterSeconds: Math.ceil((lockoutEndsAt - new Date()) / 1000)
    };
  }
  return { locked: false, attempts: attempts };
}

// ============================================================
// IP and UA helpers (unchanged - no DB calls)
// ============================================================

function getIpFromReq(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.headers['x-real-ip']
      || (req.connection && req.connection.remoteAddress)
      || null;
}

function getUserAgent(req) {
  return req.headers['user-agent'] || null;
}

// ============================================================
// HttpOnly cookie helpers (unchanged - no DB calls)
// ============================================================

const SESSION_COOKIE_NAME = 'msp_session';
const AGENCY_SESSION_COOKIE_NAME = 'msp_agency_session';

function buildCookieString(name, token, opts) {
  opts = opts || {};
  const maxAge = Math.floor((opts.maxAgeMs || SESSION_DURATION_MS) / 1000);
  const parts = [
    name + '=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + maxAge
  ];
  // Add Domain so cookies work across subdomains (e.g. mysparkplus.app + api.mysparkplus.app).
  // Driven by env var so localhost dev still works (no Domain attribute = host-only cookie).
  if (process.env.COOKIE_DOMAIN) {
    parts.push('Domain=' + process.env.COOKIE_DOMAIN);
  }
  return parts.join('; ');
}

function buildClearString(name) {
  // Domain must match what was set during cookie creation, otherwise browsers
  // refuse to clear the cookie.
  const domainPart = process.env.COOKIE_DOMAIN ? '; Domain=' + process.env.COOKIE_DOMAIN : '';
  return name + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' + domainPart;
}

function parseCookieByName(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Subaccount cookie
function buildSessionCookie(token, opts) {
  return buildCookieString(SESSION_COOKIE_NAME, token, opts);
}
function buildClearCookie() {
  return buildClearString(SESSION_COOKIE_NAME);
}
function parseSessionCookie(req) {
  // Cookie-based session (default path for normal subaccount logins)
  const fromCookie = parseCookieByName(req, SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;
  // Bearer-based session (used by agency-impersonation tabs to keep the
  // original tab's cookie session intact). Tab opens a new window with
  // a fresh sessionStorage; that storage holds the token; every fetch
  // adds 'Authorization: Bearer <token>'. The token is the same shape
  // as a cookie-stored session token, so validateSession() handles both.
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (authHeader && typeof authHeader === 'string') {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

// Agency cookie
function buildAgencySessionCookie(token, opts) {
  return buildCookieString(AGENCY_SESSION_COOKIE_NAME, token, opts);
}
function buildClearAgencyCookie() {
  return buildClearString(AGENCY_SESSION_COOKIE_NAME);
}
function parseAgencySessionCookie(req) {
  return parseCookieByName(req, AGENCY_SESSION_COOKIE_NAME);
}

module.exports = {
  hashPassword,
  verifyBcrypt,
  verifyLegacySha256,
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  recordFailedLogin,
  clearFailedLogins,
  isLockedOut,
  getIpFromReq,
  getUserAgent,
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  buildClearCookie,
  parseSessionCookie,
  AGENCY_SESSION_COOKIE_NAME,
  buildAgencySessionCookie,
  buildClearAgencyCookie,
  parseAgencySessionCookie,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  LOCKOUT_DURATION_MS,
  SESSION_DURATION_MS
};
