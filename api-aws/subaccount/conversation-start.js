// POST /api/subaccount/conversation-start
//
// Starts a new conversation by sending the first outbound message to an
// existing contact. Channel-agnostic: SMS via lib/twilio, email via lib/mailgun.
// The composer modal in the inbox calls this endpoint.
//
// Body: { contact_id, channel ('sms' | 'email'), body_text, subject (email only) }
//
// Behavior:
//   - Validates contact belongs to the authenticated subaccount
//   - Validates contact has the required channel field (phone for SMS, email for Email)
//   - For SMS: enforces plan limit via checkAndIncrementUsage
//   - Delegates send + conversation upsert to lib/twilio or lib/mailgun
//   - Reopens the conversation if it was closed or archived
//   - Audit logged as subaccount.conversation.create with channel + send metadata
//
// Returns: { success, conversation_id, channel, send_id }

const db = require('./lib/db');
const { sendSms } = require('./lib/twilio');
const { sendEmail } = require('./lib/mailgun');
const contactsLib = require('./lib/contacts');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { checkAndIncrementUsage } = require('./lib/plan-limits');

// Convert plain text to HTML safe body. Mirrors conversation-reply.js.
function textToHtml(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  out = out.replace(/(https?:\/\/[^\s<]+)/g, function(url) {
    return '<a href="' + url + '" style="color:#6b21ea;text-decoration:underline">' + url + '</a>';
  });
  out = out.replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1030">' + out + '</div>';
}

// Redact a phone number for audit logs (keep last 4 digits)
function redactPhone(p) {
  if (!p) return '';
  return String(p).replace(/\d(?=\d{4})/g, '*');
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');
  const body = req.body || {};

  const contactId = body.contact_id;
  const channel = body.channel;
  const bodyText = (body.body_text || '').trim();
  const subject = (body.subject || '').trim();

  // ── Validate inputs ─────────────────────────────────────────
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });
  if (!channel || (channel !== 'sms' && channel !== 'email')) {
    return res.status(400).json({ error: 'channel must be "sms" or "email"' });
  }
  if (!bodyText) return res.status(400).json({ error: 'body_text required' });
  if (bodyText.length > 50000) return res.status(400).json({ error: 'body_text too long (max 50000 chars)' });
  if (channel === 'email' && !subject) {
    return res.status(400).json({ error: 'subject required for email' });
  }
  if (channel === 'email' && subject.length > 500) {
    return res.status(400).json({ error: 'subject too long (max 500 chars)' });
  }

  try {
    // ── Look up contact and validate channel availability ─────
    const contact = await contactsLib.getContactById(subaccountId, contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    if (channel === 'sms' && !contact.phone) {
      return res.status(400).json({ error: 'Contact has no phone on file' });
    }
    if (channel === 'email' && !contact.email) {
      return res.status(400).json({ error: 'Contact has no email on file' });
    }

    let conversationId = null;
    let sendResultId = null;

    // ── Branch on channel ─────────────────────────────────────
    if (channel === 'sms') {
      // Plan-limit enforcement for SMS only
      const usageCheck = await checkAndIncrementUsage(slug, 'sms');
      if (!usageCheck.ok) {
        return res.status(429).json({
          error: usageCheck.error,
          code: usageCheck.code,
          current: usageCheck.current,
          limit: usageCheck.limit,
          tier: usageCheck.tier
        });
      }

      const smsResult = await sendSms(slug, {
        to: contact.phone,
        body: bodyText,
        contactId: contact.id,
        sentByUserId: auth.user_id,
        source: 'manual',
        purpose: 'transactional'
      });

      if (!smsResult.ok) {
        return res.status(500).json({ error: smsResult.error || 'SMS send failed', code: smsResult.code });
      }

      conversationId = smsResult.conversationId;
      sendResultId = smsResult.sid;
    } else {
      // Email path
      const html = textToHtml(bodyText);
      const emailResult = await sendEmail(slug, {
        scope: 'subaccount',
        source: 'manual',
        to: contact.email,
        subject,
        html,
        text: bodyText,
        contactId: contact.id,
        sentByUserId: auth.user_id
      });

      if (!emailResult.ok) {
        return res.status(502).json({ error: 'Email send failed: ' + (emailResult.error || 'unknown') });
      }

      // sendEmail calls upsertConversation internally but does not return the id.
      // Look it up by (subaccount_id, contact_id, email channel).
      const convQ = await db.query(
        `SELECT id, status FROM conversations
         WHERE subaccount_id = $1 AND contact_id = $2 AND channel = 'email'
         LIMIT 1`,
        [subaccountId, contactId]
      );
      if (!convQ.rows.length) {
        return res.status(500).json({ error: 'Conversation row not found after send' });
      }
      conversationId = convQ.rows[0].id;
      sendResultId = emailResult.id;
    }

    // ── Reopen conversation if it was closed or archived ──────
    // Neither lib helper changes status. Sending implies the user wants to
    // engage with this thread again.
    const statusQ = await db.query(
      `SELECT status FROM conversations WHERE id = $1 AND subaccount_id = $2`,
      [conversationId, subaccountId]
    );
    const wasReopened = statusQ.rows.length && statusQ.rows[0].status !== 'open';
    if (wasReopened) {
      await db.query(
        `UPDATE conversations SET status = 'open', updated_at = NOW() WHERE id = $1 AND subaccount_id = $2`,
        [conversationId, subaccountId]
      );
    }

    // ── Audit log ─────────────────────────────────────────────
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.conversation.create',
      targetType: 'conversation',
      targetId: conversationId,
      targetSubaccountId: subaccountId,
      metadata: {
        channel,
        contact_id: contact.id,
        recipient_redacted: channel === 'sms' ? redactPhone(contact.phone) : contact.email,
        send_result_id: sendResultId,
        body_length: bodyText.length,
        subject_length: channel === 'email' ? subject.length : null,
        was_reopened: !!wasReopened,
        source: 'composer'
      }
    });

    return res.status(200).json({
      success: true,
      conversation_id: conversationId,
      channel,
      send_id: sendResultId
    });
  } catch (err) {
    console.error('conversation-start error:', err);
    return res.status(500).json({ error: 'Failed to start conversation', detail: err.message });
  }
}

exports.handler = wrap(handler);
