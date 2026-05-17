// POST /api/subaccount/conversation-reply
//
// Sends a reply on an existing conversation. Threads via RFC 5322:
//   - In-Reply-To: the most recent message's SES MessageId (rebuilt as <id@us-east-2.amazonses.com>)
//   - References: full ancestor chain
//
// Body: { conversation_id, body_text }
//
// Behavior:
//   - Validates conversation belongs to the authenticated subaccount
//   - Looks up the contact's email from contacts table via conversation.contact_id
//   - Composes subject from the parent message (Re: prefix added once)
//   - Builds HTML body from plain text: escape, preserve newlines, auto-link URLs
//   - Calls lib/ses.js sendEmail with parentMessage opts so In-Reply-To + References ship
//   - Reopens conversation if it was closed
//   - Audit logged
//
// Returns: { message: { ...slim conversation_message shape... } }

const db = require('./lib/db');
const { sendEmail } = require('./lib/mailgun');
const contactsLib = require('./lib/contacts');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

// Rebuild an RFC 5322 Message-ID from a SES MessageId.
// SES rewrites our outbound Message-ID with format <ses-id@us-east-2.amazonses.com>.
// For replies we use this same format so recipient clients thread correctly.
function sesMessageIdToHeader(sesId) {
  if (!sesId) return null;
  // Strip any wrapping <> if already present
  const cleaned = String(sesId).replace(/^<|>$/g, '');
  // If it already looks like a full Message-ID with @, keep it; otherwise wrap with SES domain
  if (cleaned.indexOf('@') !== -1) return '<' + cleaned + '>';
  return '<' + cleaned + '@us-east-2.amazonses.com>';
}

// Map a conversation_messages row to the camelCase frontend shape.
// Must match conversation-thread.js exactly so the inbox renders consistently.
function messageToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    channel: row.channel,
    source: row.source,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    ccAddresses: row.cc_addresses || [],
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: row.attachments || [],
    status: row.status,
    error: row.error,
    sentByUserId: row.sent_by_user_id,
    sentByUserName: row.sent_by_user_name || null,
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

// Convert plain text to HTML safe body:
//   - Escape HTML special chars
//   - Auto-link http(s) URLs
//   - Preserve line breaks (\n -> <br>)
function textToHtml(text) {
  if (!text) return '';
  // Escape first
  let out = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Auto-link URLs (basic but safe)
  out = out.replace(/(https?:\/\/[^\s<]+)/g, function(url) {
    return '<a href="' + url + '" style="color:#6b21ea;text-decoration:underline">' + url + '</a>';
  });
  // Preserve line breaks
  out = out.replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1030">' + out + '</div>';
}

function makeReplySubject(parentSubject) {
  if (!parentSubject) return 'Re: (no subject)';
  // Dedup "Re:" if already prefixed (case-insensitive, with or without space)
  const stripped = String(parentSubject).replace(/^(re:\s*)+/i, '');
  return 'Re: ' + stripped;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const conversationId = body.conversation_id;
  const bodyText = (body.body_text || '').trim();

  if (!conversationId) return res.status(400).json({ error: 'conversation_id required' });
  if (!bodyText) return res.status(400).json({ error: 'body_text required' });
  if (bodyText.length > 50000) return res.status(400).json({ error: 'body_text too long (max 50000 chars)' });

  try {
    // 1. Look up conversation - must belong to subaccount and be email channel
    const convQ = await db.query(
      `SELECT id, contact_id, channel, status, reply_token
       FROM conversations
       WHERE id = $1 AND subaccount_id = $2`,
      [conversationId, subaccountId]
    );
    if (!convQ.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const conv = convQ.rows[0];
    if (conv.channel !== 'email') {
      return res.status(400).json({ error: 'Only email conversations support reply right now' });
    }

    // 2. Get contact and validate email
    const contact = await contactsLib.getContactById(subaccountId, conv.contact_id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

    // 3. Get parent message (most recent) for threading
    const parentQ = await db.query(
      `SELECT id, subject, external_id, external_message_id
       FROM conversation_messages
       WHERE conversation_id = $1 AND subaccount_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId, subaccountId]
    );
    const parent = parentQ.rows[0] || null;

    // 4. Get references chain (all prior messages, oldest first)
    const refsQ = await db.query(
      `SELECT external_id, external_message_id
       FROM conversation_messages
       WHERE conversation_id = $1 AND subaccount_id = $2
       ORDER BY created_at ASC`,
      [conversationId, subaccountId]
    );

    // Build References array. Prefer external_message_id (our header) but fall back
    // to a reconstructed Message-ID from external_id (SES MessageId).
    const references = refsQ.rows
      .map(function(r) {
        if (r.external_message_id) return r.external_message_id;
        return sesMessageIdToHeader(r.external_id);
      })
      .filter(Boolean);

    // In-Reply-To is the parent's Message-ID (or reconstructed from SES MessageId)
    let inReplyTo = null;
    if (parent) {
      inReplyTo = parent.external_message_id || sesMessageIdToHeader(parent.external_id);
    }

    // 5. Compose subject and body
    const parentSubject = parent ? parent.subject : null;
    const subject = makeReplySubject(parentSubject);
    const html = textToHtml(bodyText);

    // 6. Pull slug from subaccountId for sendEmail
    // subaccount_id format is 'sub-{slug}', so strip the prefix
    const slug = subaccountId.replace(/^sub-/, '');

    // 7. Send via lib/ses.js
    const sendResult = await sendEmail(slug, {
      scope: 'subaccount',
      source: 'manual',
      to: contact.email,
      subject,
      html,
      text: bodyText,
      contactId: contact.id,
      sentByUserId: auth.user_id,
      parentMessage: inReplyTo ? {
        message_id_header: inReplyTo,
        references: references
      } : null
    });

    if (!sendResult.ok) {
      return res.status(502).json({ error: 'Send failed: ' + (sendResult.error || 'unknown') });
    }

    // 8. Reopen conversation if it was closed (replying implies activity)
    if (conv.status === 'closed') {
      await db.query(
        `UPDATE conversations SET status = 'open', updated_at = NOW() WHERE id = $1 AND subaccount_id = $2`,
        [conversationId, subaccountId]
      );
    }

    // 9. Audit log
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.conversation.reply',
      targetType: 'conversation',
      targetId: conversationId,
      targetSubaccountId: subaccountId,
      metadata: {
        recipient: contact.email,
        contact_id: contact.id,
        ses_message_id: sendResult.id,
        in_reply_to: inReplyTo,
        ref_count: references.length,
        body_length: bodyText.length
      }
    });

    // 10. Pull the freshly-inserted message row with user name join
    const newMsg = await db.query(
      `SELECT m.id, m.conversation_id, m.direction, m.source, m.channel,
              m.from_address, m.to_address, m.cc_addresses,
              m.subject, m.body_text, m.body_html, m.attachments,
              m.status, m.external_id, m.external_message_id, m.in_reply_to, m.error,
              m.sent_by_user_id,
              u.display_name AS sent_by_user_name,
              m.sent_at, m.created_at
       FROM conversation_messages m
       LEFT JOIN subaccount_users u ON u.id::text = m.sent_by_user_id
       WHERE m.conversation_id = $1 AND m.subaccount_id = $2
       ORDER BY m.created_at DESC LIMIT 1`,
      [conversationId, subaccountId]
    );

    return res.status(200).json({
      success: true,
      message: messageToFrontend(newMsg.rows[0]),
      ses_message_id: sendResult.id
    });
  } catch (err) {
    console.error('conversation-reply error:', err);
    return res.status(500).json({ error: 'Failed to send reply', detail: err.message });
  }
}

exports.handler = wrap(handler);
