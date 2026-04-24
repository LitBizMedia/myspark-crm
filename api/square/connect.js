// api/square/connect.js
// Initiates the Square OAuth flow.
// The `state` parameter is a JSON object (base64 encoded) carrying the slug and a CSRF nonce.
// The callback.js handler reads this state to know which workspace is connecting.

const SQUARE_ENV = process.env.SQUARE_ENV || 'production';
const APP_ID = SQUARE_ENV === 'production'
  ? process.env.SQUARE_APP_ID_PRODUCTION
  : process.env.SQUARE_APP_ID_SANDBOX;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Slug can come from query string; defaults to litbiz for backward compat.
  const slug = (req.query.slug || 'litbiz').toString().trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
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

  const base = SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com/oauth2/authorize'
    : 'https://connect.squareupsandbox.com/oauth2/authorize';

  const redirectUrl = base
    + '?client_id=' + encodeURIComponent(APP_ID)
    + '&scope=' + scopes
    + '&session=false'
    + '&state=' + encodeURIComponent(state);

  res.writeHead(302, { Location: redirectUrl });
  res.end();
};
