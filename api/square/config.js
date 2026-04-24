// api/square/config.js
// Returns public Square configuration needed by the client to initialize the Square SDK.
// This endpoint returns only public data — the App ID, which is embedded in the
// OAuth URL anyway — and never returns access tokens or secrets.

const SQUARE_ENV = process.env.SQUARE_ENV || 'production';
const APP_ID = SQUARE_ENV === 'production'
  ? process.env.SQUARE_APP_ID_PRODUCTION
  : process.env.SQUARE_APP_ID_SANDBOX;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!APP_ID) {
    return res.status(500).json({ error: 'Square App ID not configured' });
  }
  return res.status(200).json({
    appId: APP_ID,
    env: SQUARE_ENV
  });
};
