// GET /api/subaccount/conversation-list
//
// Returns conversations for the authenticated subaccount in the slim shape
// the Inbox list view needs. Joins contact info (name, email, phone) so the
// list can render without a second lookup.
//
// Excludes archived conversations by default. Pass ?include_archived=1 to
// include them.
//
// Built as part of Conversations Stage 2 (May 13, 2026). Pattern mirrors
// contact-list.js: slim per-row shape, guardrail on response size, audit
// log of the bulk read.
//
// NOT returned here: message bodies. Those load when a conversation is
// opened, via conversation-thread.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function conversationToFrontend(row) {
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
    lastMessageAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : row.last_message_at,
    lastInboundMessageAt: row.last_inbound_message_at instanceof Date ? row.last_inbound_message_at.toISOString() : row.last_inbound_message_at,
    lastManualMessageAt: row.last_manual_message_at instanceof Date ? row.last_manual_message_at.toISOString() : row.last_manual_message_at,
    lastMessagePreview: row.last_message_preview || '',
    lastMessageDirection: row.last_message_direction || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const includeArchived = req.query && (req.query.include_archived === '1' || req.query.include_archived === 'true');

  try {
    // Pull conversations joined with contact for display fields.
    // ORDER: unread first (unread_count > 0), then by last activity desc.
    // The inbox should surface what needs attention.
    const statusClause = includeArchived ? '' : "AND c.status != 'archived'";
    const result = await db.query(
      `SELECT
         c.id, c.contact_id, c.channel, c.status, c.assigned_to,
         c.unread_count, c.reply_token,
         c.last_message_at, c.last_inbound_message_at, c.last_manual_message_at,
         c.last_message_preview, c.last_message_direction,
         c.created_at, c.updated_at,
         ct.display_name AS contact_display_name,
         ct.email AS contact_email,
         ct.phone AS contact_phone
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.subaccount_id = $1
         ${statusClause}
       ORDER BY
         (CASE WHEN c.unread_count > 0 THEN 0 ELSE 1 END),
         c.last_message_at DESC NULLS LAST,
         c.created_at DESC`,
      [subaccountId]
    );

    let conversations = result.rows.map(conversationToFrontend);
    const total = conversations.length;

    // Guardrail (same pattern as contact-list).
    const MAX_BYTES = 5 * 1024 * 1024;
    let serialized = JSON.stringify({ conversations });
    let truncated = false;
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      let lo = 0, hi = conversations.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const test = JSON.stringify({ conversations: conversations.slice(0, mid) });
        if (Buffer.byteLength(test) <= MAX_BYTES) lo = mid;
        else hi = mid - 1;
      }
      conversations = conversations.slice(0, lo);
      truncated = true;
      console.warn('conversation-list truncated:', { returned: conversations.length, total, subaccountId });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.conversation.bulk_list',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        conversation_count: conversations.length,
        total_in_db: total,
        truncated: truncated,
        include_archived: includeArchived
      }
    });

    return res.status(200).json({ conversations, total, truncated });
  } catch (err) {
    console.error('conversation-list error:', err);
    return res.status(500).json({ error: 'Failed to load conversations', detail: err.message });
  }
}

exports.handler = wrap(handler);
