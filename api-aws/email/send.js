// api/email/send.js (Lambda version)
//
// POST /api/email/send
//
// Sends transactional emails via Mailgun with template variable substitution.
// Accepts subaccount or agency sessions.
// Plan limit enforcement on email sends (429 if over limit).
//
// MIGRATED: No DB calls of its own - delegates to lib/mailgun, lib/plan-limits.

const { sendEmail } = require('./lib/mailgun');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { checkAndIncrementUsage } = require('./lib/plan-limits');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
  }

  const { slug, to, subject, html, text, fromName, templateType, contactId, vars,
          scope: bodyScope, source: bodySource } = req.body || {};

  // Template-aware scope + source mapping.
  // Caller may pass explicit scope/source to override.
  // 'welcome' is the one known agency-scope templateType; everything else is subaccount.
  function resolveScope() {
    if (bodyScope === 'agency' || bodyScope === 'subaccount') return bodyScope;
    if (templateType === 'welcome') return 'agency';
    return 'subaccount';
  }
  function resolveSource() {
    if (bodySource) return bodySource;
    const map = {
      'appt-reminder':         'reminder',
      'appt-confirmation':     'confirmation',
      'appt-cancellation':     'cancellation',
      'class-confirmation':    'confirmation',
      'class-cancellation':    'cancellation',
      'booking-confirmation':  'widget'
    };
    return map[templateType] || 'manual';
  }
  const sendScope = resolveScope();
  const sendSource = resolveSource();

  if (!slug) return res.status(400).json({ error: 'slug is required' });

  // Subaccount sessions: enforce slug match
  if (session.user_type === 'subaccount') {
    if (session.subaccount_id !== ('sub-' + slug)) {
      return res.status(403).json({ error: 'Slug does not match session' });
    }
  } else if (session.user_type !== 'agency') {
    return res.status(403).json({ error: 'Invalid session type' });
  }

  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!templateType && !subject) return res.status(400).json({ error: 'subject is required' });
  if (!templateType && !html) return res.status(400).json({ error: 'html is required' });

  // Plan limits check
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

  const result = await sendEmail(slug, { scope: sendScope, source: sendSource, to, subject, html, text, fromName, templateType, contactId, vars });

  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json({
    success: true,
    id: result.id,
    usage: { current: usageCheck.current, limit: usageCheck.limit }
  });
}

exports.handler = wrap(handler);
