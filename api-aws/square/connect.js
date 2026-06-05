// api/square/connect.js (Lambda version - Secrets Manager)
//
// GET /api/square/connect
//
// Initiates Square OAuth flow with state parameter carrying slug + CSRF nonce.
// Returns redirect (302) to Square OAuth endpoint.
//
// CREDENTIALS: APP_ID and SQUARE_ENV from Secrets Manager.

const { getOAuthAppId, getSquareEnv } = require('./lib/square');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (session.user_type === 'subaccount' && session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required to connect Square' });
  }

  const slug = (req.query.slug || 'litbiz').toString().trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }

  if (session.user_type === 'subaccount' && session.subaccount_id !== ('sub-' + slug)) {
    return res.status(403).json({ error: 'Slug does not match session' });
  }

  // Load credentials from Secrets Manager
  const [appId, squareEnv] = await Promise.all([
    getOAuthAppId(),
    getSquareEnv()
  ]);
  
  if (!appId) {
    return res.status(500).json({ error: 'Square App ID not configured' });
  }

  const nonce = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  const stateObj = { slug: slug, nonce: nonce, ts: Date.now() };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const scopes = [
    'PAYMENTS_READ',
    'PAYMENTS_WRITE',
    'CUSTOMERS_READ',
    'CUSTOMERS_WRITE',
    'ORDERS_READ',
    'ORDERS_WRITE',
    'ITEMS_READ',
    'ITEMS_WRITE',
    'MERCHANT_PROFILE_READ'
  ].join('+');

  const base = squareEnv === 'production'
    ? 'https://connect.squareup.com/oauth2/authorize'
    : 'https://connect.squareupsandbox.com/oauth2/authorize';

  const redirectUrl = base
    + '?client_id=' + encodeURIComponent(appId)
    + '&scope=' + scopes
    + '&session=false'
    + '&state=' + encodeURIComponent(state);

  res.setHeader('Location', redirectUrl);
  return res.status(302).send('');
}

exports.handler = wrap(handler);
