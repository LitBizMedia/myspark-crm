// api/square/callback.js
// Square OAuth callback handler
// Exchanges authorization code for access token server-side
// App secret never touches the browser

module.exports = async function handler(req, res) {
  const { code, error } = req.query;
  const appUrl = 'https://myspark-crm.vercel.app';

  if (error) {
    return res.redirect(302, appUrl + '/#sq_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect(302, appUrl + '/#sq_error=no_code');
  }

  const isSandbox = process.env.SQUARE_ENV !== 'production';
  const appId = isSandbox
    ? process.env.SQUARE_APP_ID_SANDBOX
    : process.env.SQUARE_APP_ID_PRODUCTION;
  const appSecret = isSandbox
    ? process.env.SQUARE_APP_SECRET_SANDBOX
    : process.env.SQUARE_APP_SECRET_PRODUCTION;
  const baseUrl = isSandbox
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  if (!appId || !appSecret) {
    return res.redirect(302, appUrl + '/#sq_error=missing_env_vars');
  }

  try {
    const response = await fetch(baseUrl + '/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23'
      },
      body: JSON.stringify({
        client_id: appId,
        client_secret: appSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: appUrl + '/api/square/callback'
      })
    });

    const data = await response.json();

    if (data.access_token) {
      const fragment = [
        'sq_token=' + encodeURIComponent(data.access_token),
        'sq_merchant=' + encodeURIComponent(data.merchant_id || ''),
        'sq_env=' + (isSandbox ? 'sandbox' : 'production')
      ].join('&');
      return res.redirect(302, appUrl + '/#' + fragment);
    }

    const msg = (data.errors && data.errors[0] && data.errors[0].detail) || data.message || 'token_failed';
    return res.redirect(302, appUrl + '/#sq_error=' + encodeURIComponent(msg));

  } catch (err) {
    console.error('Square OAuth error:', err);
    return res.redirect(302, appUrl + '/#sq_error=server_error');
  }
};
