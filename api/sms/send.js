// api/sms/send.js
// POST endpoint for sending SMS via Twilio.
// Only sends if subaccount has an approved campaign and enabled SMS.
//
// Authentication added (was missing previously - serious gap pre-fix).
// Plan limits enforcement added.

const { sendSms } = require('../../lib/twilio');
const {
  parseSessionCookie,
  parseAgencySessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');
const { checkAndIncrementUsage } = require('../../lib/plan-limits');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Accept either a subaccount session OR an agency session.
  // Same dual-cookie pattern as /api/email/send.
  const subToken = parseSessionCookie(req);
  const agencyToken = parseAgencySessionCookie(req);
  let session = null;
  if (agencyToken) {
    session = await validateSession(agencyToken);
    if (session && session.user_type !== 'agency') session = null;
  }
  if (!session && subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
  }

  const { slug, to, body, templateType, contactId, vars } = req.body || {};

  if (!slug) return res.status(400).json({ error: 'slug is required' });

  // Subaccount sessions: enforce slug matches their subaccount.
  // Agency sessions: any slug is allowed.
  if (session.user_type === 'subaccount') {
    if (session.subaccount_id !== ('sub-' + slug)) {
      return res.status(403).json({ error: 'Slug does not match session' });
    }
  } else if (session.user_type !== 'agency') {
    return res.status(403).json({ error: 'Invalid session type' });
  }

  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!body) return res.status(400).json({ error: 'body is required' });

  // Plan limits check. SMS is more cost-sensitive than email so this
  // matters more. Returns 429 with usage details on limit reached.
  const usageCheck = await checkAndIncrementUsage(slug, 'sms');
  if (!usageCheck.ok) {
    return res.status(429).json({
      error: usageCheck.error,
      code:  usageCheck.code,
      current: usageCheck.current,
      limit:   usageCheck.limit,
      tier:    usageCheck.tier
    });
  }

  const result = await sendSms(slug, { to, body, templateType, contactId, vars });

  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json({
    success: true,
    sid: result.sid,
    usage: { current: usageCheck.current, limit: usageCheck.limit }
  });
};
