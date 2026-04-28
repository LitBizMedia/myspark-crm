// api/agency/session.js
// Validates the HttpOnly session cookie and returns the agency user info.
// Used by the agency dashboard on page load to restore the session without
// requiring a fresh login each refresh.
//
// Mirrors /api/subaccount/session.js but rejects subaccount-typed sessions.

const {
  parseAgencySessionCookie,
  validateSession,
  buildClearAgencyCookie
} = require('../../lib/subaccount-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseAgencySessionCookie(req);
  if (!token) {
    return res.status(401).json({
      authenticated: false,
      error: 'No session cookie',
      code: 'NO_SESSION'
    });
  }

  const session = await validateSession(token);
  if (!session) {
    // Session invalid (expired, revoked, or token doesn't match). Clear cookie.
    res.setHeader('Set-Cookie', buildClearAgencyCookie());
    return res.status(401).json({
      authenticated: false,
      error: 'Session expired or invalid',
      code: 'INVALID_SESSION'
    });
  }

  if (session.user_type !== 'agency') {
    // Wrong session type. Don't clear the cookie since it might be valid for subaccount routes.
    return res.status(401).json({
      authenticated: false,
      error: 'Agency session required',
      code: 'WRONG_SESSION_TYPE'
    });
  }

  return res.status(200).json({
    authenticated: true,
    user: {
      id:       session.user_id,
      username: session.username,
      role:     session.role,
      name:     session.display_name || session.username
    },
    expires_at: session.expires_at
  });
};
