// api/agency/logout.js (Lambda version)
//
// POST /api/agency/logout
//
// Revokes the agency session server-side, clears the HttpOnly cookie,
// and writes an audit log entry.

const {
  parseAgencySessionCookie,
  validateSession,
  revokeSession,
  buildClearAgencyCookie
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseAgencySessionCookie(req);
  if (!token) {
    res.setHeader('Set-Cookie', buildClearAgencyCookie());
    return res.status(200).json({ success: true, note: 'No active session' });
  }

  let sessionSnapshot = null;
  try {
    sessionSnapshot = await validateSession(token);
  } catch (e) {
    // Session may already be invalid. Continue.
  }

  try {
    await revokeSession(token, 'logout');
  } catch (e) {
    console.error('agency logout: revokeSession failed:', e.message);
  }

  res.setHeader('Set-Cookie', buildClearAgencyCookie());

  if (sessionSnapshot && sessionSnapshot.user_type === 'agency') {
    try {
      await logAudit({
        req,
        actorType:     'agency',
        actorId:       sessionSnapshot.user_id,
        actorUsername: sessionSnapshot.username,
        actorRole:     sessionSnapshot.role,
        action:        'agency.logout',
        metadata:      {
          session_id: sessionSnapshot.id,
          reason: 'user_initiated'
        }
      });
    } catch (e) {
      console.error('agency logout: audit failed:', e.message);
    }
  }

  return res.status(200).json({ success: true });
}

exports.handler = wrap(handler);
