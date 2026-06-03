// lib-aws/tokens.js
// General-purpose JWT signing and verification, app-wide.
//
// Pattern: HS256 with key rotation via Secrets Manager.
// Secret stores { current: {kid, key, createdAt}, previous: {kid, key, createdAt} | null }
// Tokens carry a kid claim so verification picks the right key during rotation grace period.
//
// Signs any payload object that includes an exp (unix seconds). No domain
// assumptions. Used by contracts (via contract-tokens re-export) and intake
// form links. Secret name retained as myspark/contracts/jwt-signing-keys for
// now; renaming the secret is a separate isolated task.

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SECRET_NAME = 'myspark/contracts/jwt-signing-keys';
const REGION = 'us-east-2';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cachedKeys = null;
let _cachedAt = 0;

async function loadKeys() {
  const now = Date.now();
  if (_cachedKeys && (now - _cachedAt) < CACHE_TTL_MS) {
    return _cachedKeys;
  }
  const client = new SecretsManagerClient({ region: REGION });
  const resp = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  if (!resp.SecretString) {
    throw new Error('Secret has no string value');
  }
  _cachedKeys = JSON.parse(resp.SecretString);
  _cachedAt = now;
  return _cachedKeys;
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Sign a JWT with the current key. payload must include exp (unix seconds).
async function signToken(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('signToken requires a payload object');
  }
  if (!payload.exp || typeof payload.exp !== 'number') {
    throw new Error('signToken payload must include exp (unix seconds)');
  }
  const keys = await loadKeys();
  const k = keys.current;
  if (!k || !k.key || !k.kid) {
    throw new Error('No current signing key configured');
  }
  const header = { alg: 'HS256', typ: 'JWT', kid: k.kid };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;
  const keyBuf = Buffer.from(k.key, 'hex');
  const sig = crypto.createHmac('sha256', keyBuf).update(signingInput).digest();
  return signingInput + '.' + base64url(sig);
}

// Verify a JWT. Returns payload if valid, null if not.
// Checks signature against current AND previous key (rotation grace). Validates exp.
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload, providedSig;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
    providedSig = base64urlDecode(sigB64);
  } catch (e) {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const keys = await loadKeys();
  const candidates = [keys.current, keys.previous].filter(Boolean);
  let valid = false;
  for (const k of candidates) {
    if (header.kid && k.kid !== header.kid) continue;
    const keyBuf = Buffer.from(k.key, 'hex');
    const expected = crypto.createHmac('sha256', keyBuf)
      .update(headerB64 + '.' + payloadB64)
      .digest();
    if (expected.length === providedSig.length &&
        crypto.timingSafeEqual(expected, providedSig)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;

  if (typeof payload.exp === 'number') {
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) return null;
  }

  return payload;
}

// SHA-256 hash of the raw token string. Non-reversible DB reference.
function hashToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('hashToken requires a string');
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

function clearKeyCache() {
  _cachedKeys = null;
  _cachedAt = 0;
}

module.exports = {
  signToken,
  verifyToken,
  hashToken,
  clearKeyCache
};
