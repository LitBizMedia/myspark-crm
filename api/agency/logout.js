// api/agency/logout.js
// Revokes the agency session server-side, clears the HttpOnly cookie,
// and writes an audit log entry.

const {
  parseSessionCookie,
  validateSession,
  revokeSession,
  buildClearCookie
} = require('../../lib/subaccount-auth');
const { logAudit } = require('../../lib/audit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  if (!token) {
    // No cookie present. Clear anything stale and return success.
    res.setHeader('Set-Cookie', buildClearCookie());
    return res.status(200).json({ success: true, note: 'No active session' });
  }

  // Try to capture session info BEFORE revoking, for audit trail
  let sessionSnapshot = null;
  try {
    sessionSnapshot = await validateSession(token);
  } catch (e) {
    // Session may already be invalid or unreachable. Continue with cleanup.
  }

  try {
    await revokeSession(token, 'logout');
  } catch (e) {
    console.error('agency logout: revokeSession failed:', e.message);
    // Still clear the cookie even if DB revoke fails
  }

  res.setHeader('Set-Cookie', buildClearCookie());

  // Audit the logout (best effort, don't fail the response on audit error)
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
};
