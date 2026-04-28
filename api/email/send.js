// api/email/send.js
// POST endpoint for sending transactional emails via Resend.
// Accepts vars object for template variable substitution.
// Called by other serverless functions, not directly by the client.

const { sendEmail } = require('../../lib/resend');
const {
  parseSessionCookie,
  parseAgencySessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');
const { checkAndIncrementUsage } = require('../../lib/plan-limits');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Accept either a subaccount session OR an agency session.
  // Each lives in its own cookie since the rename, so we check both.
  // Agency sessions are inherently allowed any slug (they manage all tenants).
  // Subaccount sessions must match the slug in the request body.
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

  const { slug, to, subject, html, text, fromName, templateType, contactId, vars } = req.body || {};

  if (!slug) return res.status(400).json({ error: 'slug is required' });

  // Subaccount sessions: enforce slug matches their subaccount.
  // Agency sessions: any slug is allowed (they manage all tenants).
  if (session.user_type === 'subaccount') {
    if (session.subaccount_id !== ('sub-' + slug)) {
      return res.status(403).json({ error: 'Slug does not match session' });
    }
  } else if (session.user_type !== 'agency') {
    // Unknown session type, reject defensively
    return res.status(403).json({ error: 'Invalid session type' });
  }

  if (!to) return res.status(400).json({ error: 'to is required' });

  if (!templateType && !subject) return res.status(400).json({ error: 'subject is required' });
  if (!templateType && !html) return res.status(400).json({ error: 'html is required' });

  // Plan limits check. Atomic-ish at app layer: checks current usage and
  // increments on success. If subaccount is exempt_from_billing (LitBiz,
  // comp accounts), increments but does not block.
  const usageCheck = await checkAndIncrementUsage(slug, 'email');
  if (!usageCheck.ok) {
    return res.status(429).json({
      error: usageCheck.error,
      code:  usageCheck.code,
      current: usageCheck.current,
      limit:   usageCheck.limit,
      tier:    usageCheck.tier
    });
  }

  const result = await sendEmail(slug, { to, subject, html, text, fromName, templateType, contactId, vars });

  if (!result.ok) {
    // Send failed downstream. We already incremented the counter; that's a
    // small overcount but acceptable given the alternative (rolling back the
    // increment would require another DB call and isn't reliable under
    // concurrent load).
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json({
    success: true,
    id: result.id,
    usage: { current: usageCheck.current, limit: usageCheck.limit }
  });
};
