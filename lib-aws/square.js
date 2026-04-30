// lib/square.js
// Shared helpers for Square serverless functions.
// Uses RDS via lib/db.js to access the protected square_credentials table.
// Never import this file from client-side code. It is for /api/* only.
//
// CREDENTIALS: Two distinct credential types live here:
//
// 1. PER-SUBACCOUNT WORKSPACE TOKENS - stored in RDS square_credentials table.
//    These are the OAuth access tokens issued when each subaccount connects
//    their Square account. Used by getSquareCreds()/upsertSquareCreds()/etc.
//    Each subaccount has its own row. Already secure (RDS, encrypted at rest).
//
// 2. APPLICATION-LEVEL OAUTH CREDENTIALS - now loaded from AWS Secrets Manager
//    (myspark/integrations/square). Used by the OAuth handshake itself
//    (callback.js, connect.js, config.js) - the credentials that identify
//    OUR application to Square's OAuth server.

const db = require('./db');
const secrets = require('./secrets');

const SQUARE_SECRET_NAME = 'myspark/integrations/square';

// Cached app-level OAuth credentials (populated on first use)
let _appCreds = undefined;
async function getAppCreds() {
  if (_appCreds !== undefined) return _appCreds;
  try {
    _appCreds = await secrets.get(SQUARE_SECRET_NAME);
  } catch (e) {
    console.error('lib/square.js: failed to load app credentials from Secrets Manager:', e.message);
    _appCreds = null;
  }
  return _appCreds;
}

// Get the configured Square environment ('production' or 'sandbox')
async function getSquareEnv() {
  const c = await getAppCreds();
  if (c && c.SQUARE_ENV) return c.SQUARE_ENV;
  return process.env.SQUARE_ENV || 'production';
}

// Get the OAuth Application ID for the current environment
async function getOAuthAppId() {
  const c = await getAppCreds();
  if (!c) return null;
  const env = await getSquareEnv();
  return env === 'production' ? c.SQUARE_APP_ID_PRODUCTION : c.SQUARE_APP_ID_SANDBOX;
}

// Get the OAuth Application Secret for the current environment
async function getOAuthAppSecret() {
  const c = await getAppCreds();
  if (!c) return null;
  const env = await getSquareEnv();
  return env === 'production' ? c.SQUARE_APP_SECRET_PRODUCTION : c.SQUARE_APP_SECRET_SANDBOX;
}

// ============================================================
// Per-subaccount workspace credentials (unchanged - in RDS)
// ============================================================

// Look up Square credentials for a workspace by slug.
// Returns { access_token, refresh_token, merchant_id, location_id, sandbox, expires_at } or null.
async function getSquareCreds(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const subaccountId = 'sub-' + slug;
  try {
    return await db.findOne('square_credentials', { subaccount_id: subaccountId });
  } catch (err) {
    console.error('getSquareCreds: query failed:', err.message);
    return null;
  }
}

// Upsert Square credentials. Used by the OAuth callback.
async function upsertSquareCreds(slug, fields) {
  if (!slug) throw new Error('slug is required');
  if (!fields || !fields.accessToken) throw new Error('accessToken is required');
  const subaccountId = 'sub-' + slug;
  const row = {
    subaccount_id: subaccountId,
    access_token:  fields.accessToken,
    refresh_token: fields.refreshToken || null,
    merchant_id:   fields.merchantId || null,
    location_id:   fields.locationId || null,
    sandbox:       !!fields.sandbox,
    expires_at:    fields.expiresAt || null,
    updated_at:    new Date().toISOString()
  };
  try {
    await db.insert('square_credentials', row, { onConflict: 'subaccount_id' });
    return true;
  } catch (err) {
    throw new Error('upsertSquareCreds failed: ' + err.message);
  }
}

// Delete credentials for a workspace (used when a subaccount disconnects Square).
async function deleteSquareCreds(slug) {
  if (!slug) throw new Error('slug is required');
  const subaccountId = 'sub-' + slug;
  try {
    await db.deleteWhere('square_credentials', { subaccount_id: subaccountId });
    return true;
  } catch (err) {
    throw new Error('deleteSquareCreds failed: ' + err.message);
  }
}

// Square API host depending on sandbox flag.
function squareHost(sandbox) {
  return sandbox ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
}

// Standard authorization headers for Square API calls.
function squareHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Square-Version': '2025-01-23'
  };
}

// Consistent error response writer.
function sendError(res, status, message, details) {
  const body = { error: message };
  if (details) body.details = details;
  return res.status(status).json(body);
}

module.exports = {
  // Per-subaccount workspace token helpers
  getSquareCreds,
  upsertSquareCreds,
  deleteSquareCreds,
  // Application-level OAuth credential helpers
  getSquareEnv,
  getOAuthAppId,
  getOAuthAppSecret,
  // Utilities
  squareHost,
  squareHeaders,
  sendError
};
