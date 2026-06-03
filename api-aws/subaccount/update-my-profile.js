// api/subaccount/update-my-profile.js (Lambda version)
//
// POST /api/subaccount/update-my-profile
//
// Self-service profile update for the logged-in subaccount user.
// Any valid session may edit ONLY its own row, and ONLY the phone field.
// No role check. No target id from the client. No session revoke. No cookie rotation.
//
// Security:
//   - Auth: any valid subaccount session
//   - Operates strictly on session.user_id (client cannot name a target)
//   - Phone normalized to E.164 server-side; non-empty invalid rejected; empty clears
//   - Audited (subaccount.user.self_update)

const db = require('./lib/db');
const { parseSessionCookie, validateSession } = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { normalizePhone } = require('./lib/phone');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (String(session.user_id).startsWith('breakglass-')) {
    return res.status(403).json({ error: 'Break-glass session cannot edit profile.' });
  }

  const { phone } = req.body || {};
  if (phone === undefined) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  // Normalize phone. Empty clears; non-empty invalid is rejected.
  let normPhone = null;
  if (phone !== null && String(phone).trim() !== '') {
    normPhone = normalizePhone(phone);
    if (!normPhone) {
      return res.status(400).json({ error: 'Enter a valid phone number.' });
    }
  }

  let user;
  try {
    user = await db.findOne('subaccount_users', { id: session.user_id });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load user: ' + e.message });
  }
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (normPhone === (user.phone || null)) {
    return res.status(200).json({ success: true, noChange: true, phone: user.phone || null });
  }

  try {
    await db.update('subaccount_users',
      { phone: normPhone, updated_at: new Date().toISOString() },
      { id: user.id }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Update failed: ' + e.message });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: user.id,
    actorUsername: user.username,
    actorRole: user.role,
    action: 'subaccount.user.self_update',
    targetType: 'subaccount_user',
    targetId: user.id,
    targetSubaccountId: user.subaccount_id,
    metadata: { changed_fields: ['phone'] }
  });

  return res.status(200).json({ success: true, phone: normPhone });
}

exports.handler = wrap(handler);
