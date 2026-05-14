// POST /api/subaccount/conversation-update
//
// Updates a single conversation. Three actions supported:
//   - mark_read: sets unread_count = 0
//   - mark_unread: sets unread_count = 1 (or increments if already > 0)
//   - set_status: changes status to 'open' | 'closed' | 'archived'
//
// Body:
//   { id, action: 'mark_read' | 'mark_unread' | 'set_status', status? }
//
// Returns the updated conversation row in the same slim shape as
// conversation-list, so the frontend can swap it in without refetch.
//
// Tenant isolation: every query filters by subaccount_id from session auth.
// Conversation id alone is never trusted.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const VALID_STATUSES = ['open', 'closed', 'archived'];
const VALID_ACTIONS = ['mark_read', 'mark_unread', 'set_status'];

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const conversationId = body.id;
  const action = body.action;

  if (!conversationId) return res.status(400).json({ error: 'id required' });
  if (!action || VALID_ACTIONS.indexOf(action) === -1) {
    return res.status(400).json({ error: 'action must be one of: ' + VALID_ACTIONS.join(', ') });
  }

  try {
    // Verify conversation exists and belongs to this subaccount before touching it
    const check = await db.query(
      `SELECT id, status, unread_count FROM conversations WHERE id = $1 AND subaccount_id = $2`,
      [conversationId, subaccountId]
    );
    if (!check.rows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const before = check.rows[0];

    // Build the update by action
    let auditAction = '';
    let auditMetadata = {};
    if (action === 'mark_read') {
      await db.query(
        `UPDATE conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1 AND subaccount_id = $2`,
        [conversationId, subaccountId]
      );
      auditAction = 'subaccount.conversation.mark_read';
      auditMetadata = { previous_unread: before.unread_count };
    } else if (action === 'mark_unread') {
      // Bump unread_count to at least 1
      const newCount = Math.max(1, (before.unread_count || 0) + 1);
      await db.query(
        `UPDATE conversations SET unread_count = $1, updated_at = NOW() WHERE id = $2 AND subaccount_id = $3`,
        [newCount, conversationId, subaccountId]
      );
      auditAction = 'subaccount.conversation.mark_unread';
      auditMetadata = { new_unread: newCount };
    } else if (action === 'set_status') {
      const newStatus = body.status;
      if (!newStatus || VALID_STATUSES.indexOf(newStatus) === -1) {
        return res.status(400).json({ error: 'status must be one of: ' + VALID_STATUSES.join(', ') });
      }
      if (newStatus === before.status) {
        // No-op, fall through and return current state
      } else {
        await db.query(
          `UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2 AND subaccount_id = $3`,
          [newStatus, conversationId, subaccountId]
        );
      }
      auditAction = 'subaccount.conversation.set_status';
      auditMetadata = { previous_status: before.status, new_status: newStatus };
    }

    // Re-fetch with contact join for return shape
    const updated = await db.query(
      `SELECT
         c.id, c.contact_id, c.channel, c.status, c.assigned_to,
         c.unread_count,
         c.last_message_at, c.last_inbound_message_at, c.last_manual_message_at,
         c.last_message_preview, c.last_message_direction,
         c.created_at, c.updated_at,
         ct.display_name AS contact_display_name,
         ct.email AS contact_email,
         ct.phone AS contact_phone
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.id = $1 AND c.subaccount_id = $2`,
      [conversationId, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: auditAction,
      targetType: 'conversation',
      targetId: conversationId,
      targetSubaccountId: subaccountId,
      metadata: auditMetadata
    });

    return res.status(200).json({ conversation: conversationToFrontend(updated.rows[0]) });
  } catch (err) {
    console.error('conversation-update error:', err);
    return res.status(500).json({ error: 'Failed to update conversation', detail: err.message });
  }
}

exports.handler = wrap(handler);
