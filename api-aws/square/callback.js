// api/square/callback.js (Lambda version - Secrets Manager)
//
// GET /api/square/callback
//
// OAuth callback handler. Exchanges code for access token, writes to
// square_credentials, marks subaccount_data.settings.square as connected.
// Returns redirect (302).
//
// CREDENTIALS: APP_ID and APP_SECRET loaded from Secrets Manager via
// lib/square.js. Cached on first cold start.

const db = require('./lib/db');
const { upsertSquareCreds, getOAuthAppId, getOAuthAppSecret, getSquareEnv } = require('./lib/square');
const { wrap } = require('./lib/lambda-adapter');

const APP_ORIGIN = process.env.APP_URL || 'https://mysparkplus.app';

function safeSlug(s) {
  if (!s || typeof s !== 'string') return null;
  const clean = s.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean || null;
}

function redirectWithError(res, slug, msg) {
  const target = APP_ORIGIN + '/' + (slug || 'litbiz') + '#sq_error=' + encodeURIComponent(msg);
  res.setHeader('Location', target);
  return res.status(302).send('');
}

async function markConnectedInSubaccountData(slug, merchantId, sandbox) {
  const subaccountId = 'sub-' + slug;
  
  let row;
  try {
    row = await db.findOne('subaccount_data',
      { subaccount_id: subaccountId },
      { select: 'data' }
    );
  } catch (e) {
    console.warn('markConnectedInSubaccountData: fetch failed:', e.message);
    return;
  }
  
  if (!row) {
    console.warn('markConnectedInSubaccountData: no subaccount_data row for ' + slug);
    return;
  }
  
  const data = row.data || {};
  data.settings = data.settings || {};
  data.settings.square = Object.assign({}, data.settings.square || {}, {
    connected: true,
    accessToken: '',
    merchantId: merchantId || '',
    sandbox: !!sandbox,
    connectedAt: new Date().toISOString()
  });
  
  try {
    await db.update('subaccount_data',
      { data: data, updated_at: new Date().toISOString() },
      { subaccount_id: subaccountId }
    );
  } catch (e) {
    console.warn('markConnectedInSubaccountData: patch failed:', e.message);
  }
}

async function handler(req, res) {
  const code = req.query.code;
  const rawState = req.query.state;
  const oauthError = req.query.error;

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

  // Load OAuth credentials from Secrets Manager
  const [appId, appSecret, squareEnv] = await Promise.all([
    getOAuthAppId(),
    getOAuthAppSecret(),
    getSquareEnv()
  ]);
  
  if (!appId || !appSecret) {
    console.error('callback.js: OAuth credentials not configured');
    return redirectWithError(res, slug, 'oauth_not_configured');
  }

  const TOKEN_URL = squareEnv === 'production'
    ? 'https://connect.squareup.com/oauth2/token'
    : 'https://connect.squareupsandbox.com/oauth2/token';

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
      body: JSON.stringify({
        client_id: appId,
        client_secret: appSecret,
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

    await upsertSquareCreds(slug, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      merchantId: tokenData.merchant_id || null,
      sandbox: squareEnv !== 'production',
      expiresAt: tokenData.expires_at || null
    });

    try {
      await markConnectedInSubaccountData(slug, tokenData.merchant_id || null, squareEnv !== 'production');
    } catch (markErr) {
      console.warn('callback.js: marker write failed, continuing:', markErr.message);
    }

    const target = APP_ORIGIN + '/' + slug + '#sq_connected=1&sq_merchant=' + encodeURIComponent(tokenData.merchant_id || '');
    res.setHeader('Location', target);
    return res.status(302).send('');
  } catch (err) {
    console.error('callback.js error:', err);
    return redirectWithError(res, slug, err.message || 'callback_error');
  }
}

exports.handler = wrap(handler);
