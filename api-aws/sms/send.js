// POST /api/sms/send
//
// Sends an SMS via Twilio. Slim wrapper around lib-aws/twilio.sendSms.
// All the heavy lifting (Secrets Manager auth, conversation logging,
// status callback, plan limits) is in the lib.

const { sendSms } = require('./lib/twilio');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { checkAndIncrementUsage } = require('./lib/plan-limits');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
  }

  const { slug, to, body, templateType, contactId, vars, source } = req.body || {};

  if (!slug) return res.status(400).json({ error: 'slug is required' });

  if (session.subaccount_id !== ('sub-' + slug)) {
    return res.status(403).json({ error: 'Slug does not match session' });
  }

  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!body) return res.status(400).json({ error: 'body is required' });

  const usageCheck = await checkAndIncrementUsage(slug, 'sms');
  if (!usageCheck.ok) {
    return res.status(429).json({
      error: usageCheck.error, code: usageCheck.code,
      current: usageCheck.current, limit: usageCheck.limit, tier: usageCheck.tier
    });
  }

  const result = await sendSms(slug, {
    to, body, templateType, contactId, vars,
    source: source || 'manual',
    sentByUserId: session.user_id,
    purpose: 'transactional'
  });

  if (!result.ok) {
    return res.status(500).json({ error: result.error, code: result.code });
  }

  // Audit log for PHI compliance
  await logAudit({
    req,
    actorType: session.user_type,
    actorId: session.user_id,
    actorUsername: session.username,
    actorRole: session.role,
    action: 'subaccount.sms.send',
    targetType: 'sms_message',
    targetId: result.messageId,
    targetSubaccountId: 'sub-' + slug,
    metadata: {
      to_redacted: to.replace(/\d(?=\d{4})/g, '*'),
      twilio_sid: result.sid,
      conversation_id: result.conversationId,
      length: body.length,
      source: source || 'manual'
    }
  });

  return res.status(200).json({
    success: true,
    sid: result.sid,
    messageId: result.messageId,
    conversationId: result.conversationId,
    usage: { current: usageCheck.current, limit: usageCheck.limit }
  });
}

exports.handler = wrap(handler);
