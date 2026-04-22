// api/square/config.js
// Returns public-facing Square App ID to the browser
// App secret is never returned

module.exports = async function handler(req, res) {
  const appId = process.env.SQUARE_APP_ID_PRODUCTION;
  if (!appId) {
    return res.status(500).json({ error: 'Square not configured' });
  }
  return res.status(200).json({ appId });
};
