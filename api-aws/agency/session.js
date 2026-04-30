// api/agency/session.js (Lambda version)
//
// GET /api/agency/session
//
// Validates the HttpOnly agency session cookie and returns user info.
// Mirrors /api/subaccount/session.js but rejects subaccount-typed sessions.

const {
  parseAgencySessionCookie,
  validateSession,
  buildClearAgencyCookie
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
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
    res.setHeader('Set-Cookie', buildClearAgencyCookie());
    return res.status(401).json({
      authenticated: false,
      error: 'Session expired or invalid',
      code: 'INVALID_SESSION'
    });
  }

  if (session.user_type !== 'agency') {
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
}

exports.handler = wrap(handler);
