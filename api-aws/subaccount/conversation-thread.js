// GET /api/subaccount/conversation-thread?id=<conversation_id>
//
// Returns full message thread for one conversation. Loaded when user
// opens a conversation in the Inbox UI.
//
// Returns:
//   - conversation header (status, contact info, unread_count, etc.)
//   - all messages ordered oldest-first (chronological display)
//   - sender display info for outbound messages (subaccount user name)
//
// Audit log: subaccount.conversation.view with conversation_id

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function conversationHeaderToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_display_name || null,
    contactEmail: row.contact_email || null,
    contactPhone: row.contact_phone || null,
    channel: row.channel,
    status: row.status,
    assignedTo: row.assigned_to || null,
    unreadCount: row.unread_count || 0,
    replyToken: row.reply_token,
    lastMessageAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : row.last_message_at,
    lastInboundMessageAt: row.last_inbound_message_at instanceof Date ? row.last_inbound_message_at.toISOString() : row.last_inbound_message_at,
    lastManualMessageAt: row.last_manual_message_at instanceof Date ? row.last_manual_message_at.toISOString() : row.last_manual_message_at,
    lastMessageDirection: row.last_message_direction || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

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

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const conversationId = req.query && req.query.id;
  if (!conversationId) {
    return res.status(400).json({ error: 'id query parameter required' });
  }

  try {
    // Header: conversation row + joined contact info.
    // Tenant isolation: subaccount_id MUST match. Never trust the id alone.
    const headerResult = await db.query(
      `SELECT
         c.id, c.contact_id, c.channel, c.status, c.assigned_to,
         c.unread_count, c.reply_token,
         c.last_message_at, c.last_inbound_message_at, c.last_manual_message_at,
         c.last_message_direction,
         c.created_at, c.updated_at,
         ct.display_name AS contact_display_name,
         ct.email AS contact_email,
         ct.phone AS contact_phone
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.id = $1 AND c.subaccount_id = $2`,
      [conversationId, subaccountId]
    );

    if (!headerResult.rows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = conversationHeaderToFrontend(headerResult.rows[0]);

    // Messages oldest-first, with display name of sender for outbound messages
    const messagesResult = await db.query(
      `SELECT
         m.id, m.conversation_id, m.direction, m.channel, m.source,
         m.from_address, m.to_address, m.cc_addresses,
         m.subject, m.body_text, m.body_html, m.attachments,
         m.external_id, m.external_message_id, m.in_reply_to,
         m.status, m.error,
         m.sent_by_user_id,
         u.display_name AS sent_by_user_name,
         m.sent_at, m.created_at
       FROM conversation_messages m
       LEFT JOIN subaccount_users u ON u.id::text = m.sent_by_user_id
       WHERE m.conversation_id = $1 AND m.subaccount_id = $2
       ORDER BY m.created_at ASC`,
      [conversationId, subaccountId]
    );

    const messages = messagesResult.rows.map(messageToFrontend);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.conversation.view',
      targetType: 'conversation',
      targetId: conversationId,
      targetSubaccountId: subaccountId,
      metadata: { message_count: messages.length }
    });

    return res.status(200).json({ conversation, messages });
  } catch (err) {
    console.error('conversation-thread error:', err);
    return res.status(500).json({ error: 'Failed to load conversation thread', detail: err.message });
  }
}

exports.handler = wrap(handler);
