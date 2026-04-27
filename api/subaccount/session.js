// api/subaccount/session.js
// Returns the current session info if the cookie is valid.
// Used by the frontend on page load to validate a stored session
// before allowing access to the app.

const {
  parseSessionCookie,
  validateSession,
  buildClearCookie
} = require('../../lib/subaccount-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'No session cookie', authenticated: false });
  }

  const session = await validateSession(token);
  if (!session) {
    // Stale or invalid - clear the cookie so the browser stops sending it
    res.setHeader('Set-Cookie', buildClearCookie());
    return res.status(401).json({ error: 'Invalid or expired session', authenticated: false });
  }

  // Only return non-sensitive session info
  return res.status(200).json({
    authenticated: true,
    user: {
      id: session.user_id,
      username: session.username,
      role: session.role,
      name: session.display_name || session.username,
      type: session.user_type,
      subaccount_id: session.subaccount_id
    },
    expires_at: session.expires_at
  });
};
