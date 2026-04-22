module.exports = async function handler(req, res) {
  const appId = process.env.SQUARE_APP_ID_PRODUCTION;
  const redirectUri = 'https://myspark-crm.vercel.app/api/square/callback';

  if (!appId) {
    return res.redirect(302, 'https://myspark-crm.vercel.app/#sq_error=not_configured');
  }

  const scopes = 'MERCHANT_PROFILE_READ+PAYMENTS_WRITE+PAYMENTS_READ+CUSTOMERS_WRITE+CUSTOMERS_READ';
  const state = Math.random().toString(36).slice(2);
  const url = 'https://connect.squareup.com/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(appId)
    + '&scope=' + scopes
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&state=' + state;

  return res.redirect(302, url);
};
