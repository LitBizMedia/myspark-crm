// lib/subaccount-auth.js
// Server-side authentication helpers for subaccount login.
// Uses bcrypt for password storage and crypto.randomBytes for session tokens.

const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // Pure JS bcrypt, no native deps. Works on Vercel.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Lockout configuration
const LOCKOUT_THRESHOLD = 5;             // failures before lockout
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minute window for counting
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minute lockout

// Session configuration
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10; // Standard rounds, balances cost and security

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

// ============================================================
// Password hashing
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

// Verify a SHA-256 legacy hash. Used during the migration window only.
function verifyLegacySha256(plaintext, legacyHash) {
  if (!plaintext || !legacyHash) return false;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return hash === legacyHash;
}

// ============================================================
// Session tokens
// ============================================================

// Generate a 32-byte random token returned as URL-safe base64
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Hash a session token for DB storage. Uses SHA-256 (NOT bcrypt) since
// these tokens are already 256 bits of entropy and we need fast lookup.
// bcrypt would be too slow for per-request session validation.
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
    user_type: opts.userType, // 'agency' | 'subaccount'
    subaccount_id: opts.subaccountId || null,
    username: opts.username,
    display_name: opts.displayName || opts.username,
    role: opts.role || null,
    ip_address: opts.ipAddress || null,
    user_agent: opts.userAgent ? String(opts.userAgent).slice(0, 500) : null,
    expires_at: expiresAt
  };

  const res = await fetch(SUPABASE_URL + '/rest/v1/sessions', {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Failed to create session: ' + errText);
  }

  const created = await res.json();
  return {
    token: token,
    sessionId: created[0] && created[0].id,
    expiresAt: expiresAt
  };
}

async function validateSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const url = SUPABASE_URL + '/rest/v1/sessions'
    + '?token_hash=eq.' + encodeURIComponent(tokenHash)
    + '&select=*';
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows || !rows.length) return null;
  const session = rows[0];
  if (session.revoked_at) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  // Touch last_used_at (best-effort, don't block on this)
  fetch(SUPABASE_URL + '/rest/v1/sessions?id=eq.' + session.id, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({ last_used_at: new Date().toISOString() })
  }).catch(function(){});

  return session;
}

async function revokeSession(token, reason) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  const res = await fetch(SUPABASE_URL + '/rest/v1/sessions?token_hash=eq.' + encodeURIComponent(tokenHash), {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason || 'logout'
    })
  });
  return res.ok;
}

async function revokeAllUserSessions(userId, userType, reason) {
  const url = SUPABASE_URL + '/rest/v1/sessions'
    + '?user_id=eq.' + encodeURIComponent(userId)
    + '&user_type=eq.' + encodeURIComponent(userType)
    + '&revoked_at=is.null';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason || 'revoked'
    })
  });
  return res.ok;
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
  await fetch(SUPABASE_URL + '/rest/v1/failed_login_attempts', {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(row)
  }).catch(function(){});
}

async function clearFailedLogins(opts) {
  const subFilter = opts.subaccountId ? '&subaccount_id=eq.' + encodeURIComponent(opts.subaccountId) : '&subaccount_id=is.null';
  const url = SUPABASE_URL + '/rest/v1/failed_login_attempts'
    + '?username=ilike.' + encodeURIComponent(opts.username)
    + subFilter;
  await fetch(url, { method: 'DELETE', headers: sbHeaders() }).catch(function(){});
}

async function isLockedOut(opts) {
  const cutoff = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();
  const subFilter = opts.subaccountId
    ? '&subaccount_id=eq.' + encodeURIComponent(opts.subaccountId)
    : '&subaccount_id=is.null';
  const url = SUPABASE_URL + '/rest/v1/failed_login_attempts'
    + '?username=ilike.' + encodeURIComponent(opts.username)
    + subFilter
    + '&attempted_at=gte.' + encodeURIComponent(cutoff)
    + '&select=attempted_at&order=attempted_at.desc&limit=' + (LOCKOUT_THRESHOLD + 1);
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return { locked: false, attempts: 0 };
  const rows = await res.json();
  const attempts = (rows || []).length;
  if (attempts < LOCKOUT_THRESHOLD) return { locked: false, attempts: attempts };

  // Lockout starts from the most recent failure, lasts LOCKOUT_DURATION_MS
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
// IP and UA helpers
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
// HttpOnly cookie helpers
// ============================================================

const SESSION_COOKIE_NAME = 'msp_session';

function buildSessionCookie(token, opts) {
  opts = opts || {};
  const maxAge = Math.floor((opts.maxAgeMs || SESSION_DURATION_MS) / 1000);
  const parts = [
    SESSION_COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + maxAge
  ];
  return parts.join('; ');
}

function buildClearCookie() {
  return SESSION_COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function parseSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(new RegExp('(?:^|; )' + SESSION_COOKIE_NAME + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = {
  // Password
  hashPassword,
  verifyBcrypt,
  verifyLegacySha256,
  // Sessions
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  // Lockout
  recordFailedLogin,
  clearFailedLogins,
  isLockedOut,
  // Request helpers
  getIpFromReq,
  getUserAgent,
  // Cookies
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  buildClearCookie,
  parseSessionCookie,
  // Constants exposed for testing
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  LOCKOUT_DURATION_MS,
  SESSION_DURATION_MS
};
