// lib/square.js
// Shared helpers for Square serverless functions.
// Uses the Supabase service_role key to access the protected square_credentials table.
// Never import this file from client-side code. It is for /api/* only.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('lib/square.js: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

// Look up Square credentials for a workspace by slug.
// Returns { access_token, refresh_token, merchant_id, location_id, sandbox, expires_at } or null.
async function getSquareCreds(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const subaccountId = 'sub-' + slug;
  const url = SUPABASE_URL + '/rest/v1/square_credentials?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=*';
  const res = await fetch(url, { headers: svcHeaders() });
  if (!res.ok) {
    console.error('getSquareCreds: Supabase returned ' + res.status);
    return null;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0];
}

// Upsert Square credentials. Used by the OAuth callback.
async function upsertSquareCreds(slug, fields) {
  if (!slug) throw new Error('slug is required');
  if (!fields || !fields.accessToken) throw new Error('accessToken is required');
  const subaccountId = 'sub-' + slug;
  const body = {
    subaccount_id: subaccountId,
    access_token: fields.accessToken,
    refresh_token: fields.refreshToken || null,
    merchant_id: fields.merchantId || null,
    location_id: fields.locationId || null,
    sandbox: !!fields.sandbox,
    expires_at: fields.expiresAt || null,
    updated_at: new Date().toISOString()
  };
  const url = SUPABASE_URL + '/rest/v1/square_credentials';
  const res = await fetch(url, {
    method: 'POST',
    headers: svcHeaders({
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('upsertSquareCreds failed: ' + res.status + ' ' + errText);
  }
  return true;
}

// Delete credentials for a workspace (used when a subaccount disconnects Square).
async function deleteSquareCreds(slug) {
  if (!slug) throw new Error('slug is required');
  const subaccountId = 'sub-' + slug;
  const url = SUPABASE_URL + '/rest/v1/square_credentials?subaccount_id=eq.' + encodeURIComponent(subaccountId);
  const res = await fetch(url, { method: 'DELETE', headers: svcHeaders() });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('deleteSquareCreds failed: ' + res.status + ' ' + errText);
  }
  return true;
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
  getSquareCreds,
  upsertSquareCreds,
  deleteSquareCreds,
  squareHost,
  squareHeaders,
  sendError
};
