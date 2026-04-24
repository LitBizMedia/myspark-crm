// api/square/callback.js
// OAuth callback handler. Exchanges the authorization code for an access token,
// writes the token to the secured square_credentials table,
// and also writes a connection marker to subaccount_data so the client UI knows Square is connected.

const { upsertSquareCreds } = require('../../lib/square');

const SQUARE_ENV = process.env.SQUARE_ENV || 'production';
const APP_ID = SQUARE_ENV === 'production'
  ? process.env.SQUARE_APP_ID_PRODUCTION
  : process.env.SQUARE_APP_ID_SANDBOX;
const APP_SECRET = SQUARE_ENV === 'production'
  ? process.env.SQUARE_APP_SECRET_PRODUCTION
  : process.env.SQUARE_APP_SECRET_SANDBOX;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TOKEN_URL = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com/oauth2/token'
  : 'https://connect.squareupsandbox.com/oauth2/token';

function safeSlug(s) {
  if (!s || typeof s !== 'string') return null;
  const clean = s.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean || null;
}

function redirectWithError(res, slug, msg) {
  const target = '/' + (slug || 'litbiz') + '#sq_error=' + encodeURIComponent(msg);
  res.writeHead(302, { Location: target });
  res.end();
}

// Updates the client-visible settings.square marker inside subaccount_data.
// Writes only non-sensitive fields so the client UI shows "Connected".
// The real access_token lives only in square_credentials.
async function markConnectedInSubaccountData(slug, merchantId, sandbox) {
  const subaccountId = 'sub-' + slug;
  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  };
  // Fetch the current blob
  const getRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=data', { headers: headers });
  if (!getRes.ok) {
    console.warn('markConnectedInSubaccountData: fetch failed', getRes.status);
    return;
  }
  const rows = await getRes.json();
  if (!Array.isArray(rows) || !rows.length) {
    console.warn('markConnectedInSubaccountData: no subaccount_data row for ' + slug);
    return;
  }
  const data = rows[0].data || {};
  data.settings = data.settings || {};
  data.settings.square = Object.assign({}, data.settings.square || {}, {
    accessToken: 'stored-in-square-credentials',
    merchantId: merchantId || '',
    sandbox: !!sandbox,
    connectedAt: new Date().toISOString()
  });
  const patchRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId), {
    method: 'PATCH',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
  });
  if (!patchRes.ok) {
    console.warn('markConnectedInSubaccountData: patch failed', patchRes.status, await patchRes.text());
  }
}

module.exports = async (req, res) => {
  const code = req.query.code;
  const rawState = req.query.state;
  const oauthError = req.query.error;

  // Parse state to get slug
  let slug = 'litbiz';
  try {
    if (rawState) {
      const decoded = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8'));
      if (decoded && decoded.slug) slug = safeSlug(decoded.slug) || 'litbiz';
    }
  } catch (e) {
    console.warn('callback.js: could not parse state', e.message);
  }

  if (oauthError) {
    return redirectWithError(res, slug, oauthError);
  }
  if (!code) {
    return redirectWithError(res, slug, 'missing_code');
  }

  try {
    // Exchange the code for an access token
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
      body: JSON.stringify({
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code: code,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = (tokenData.errors && tokenData.errors[0] && tokenData.errors[0].detail) || 'token_exchange_failed';
      console.error('callback.js: token exchange failed', tokenData);
      return redirectWithError(res, slug, msg);
    }

    // Write to the secured table
    await upsertSquareCreds(slug, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      merchantId: tokenData.merchant_id || null,
      sandbox: SQUARE_ENV !== 'production',
      expiresAt: tokenData.expires_at || null
    });

    // Write a non-sensitive marker to subaccount_data so the client UI updates
    try {
      await markConnectedInSubaccountData(slug, tokenData.merchant_id || null, SQUARE_ENV !== 'production');
    } catch (markErr) {
      console.warn('callback.js: marker write failed, continuing:', markErr.message);
    }

    // Redirect back to the workspace with success flag
    const target = '/' + slug + '#sq_connected=1&sq_merchant=' + encodeURIComponent(tokenData.merchant_id || '');
    res.writeHead(302, { Location: target });
    res.end();
  } catch (err) {
    console.error('callback.js error:', err);
    return redirectWithError(res, slug, err.message || 'callback_error');
  }
};
