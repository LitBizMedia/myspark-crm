// api/subaccount/logout.js (Lambda version)
//
// POST /api/subaccount/logout
//
// Revokes the current session and clears the session cookie.

const { logAudit } = require('./lib/audit');
const {
  parseSessionCookie,
  validateSession,
  revokeSession,
  buildClearCookie
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  if (!token) {
    res.setHeader('Set-Cookie', buildClearCookie());
    return res.status(200).json({ success: true });
  }

  const session = await validateSession(token);
  await revokeSession(token, 'logout');

  if (session) {
    await logAudit({
      req,
      actorType: session.user_type,
      actorId: session.user_id,
      actorUsername: session.username,
      actorRole: session.role,
      action: session.user_type === 'agency' ? 'agency.logout' : 'subaccount.logout',
      targetType: session.user_type === 'agency' ? 'agency' : 'subaccount',
      targetId: session.subaccount_id || null,
      targetSubaccountId: session.subaccount_id || null,
      metadata: { session_id: session.id }
    });
  }

  res.setHeader('Set-Cookie', buildClearCookie());
  return res.status(200).json({ success: true });
}

exports.handler = wrap(handler);
