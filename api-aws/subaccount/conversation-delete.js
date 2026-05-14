// POST /api/subaccount/conversation-delete
//
// Hard-deletes a conversation. Server-side guards:
//   - Conversation must belong to the authenticated subaccount
//   - Conversation must currently be in 'archived' status (no accidental destruction of active threads)
//
// Cascade: deletes all conversation_messages for that conversation in the same transaction.
//
// Body: { id }
//
// Returns: { deleted: true, id }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const conversationId = body.id;

  if (!conversationId) return res.status(400).json({ error: 'id required' });

  try {
    // Verify exists, belongs to subaccount, AND is archived
    const check = await db.query(
      `SELECT id, status, contact_id, channel
       FROM conversations
       WHERE id = $1 AND subaccount_id = $2`,
      [conversationId, subaccountId]
    );
    if (!check.rows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = check.rows[0];
    if (conv.status !== 'archived') {
      return res.status(400).json({
        error: 'Conversation must be archived before it can be deleted',
        current_status: conv.status
      });
    }

    // Count messages before delete for audit log
    const msgCount = await db.query(
      `SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = $1 AND subaccount_id = $2`,
      [conversationId, subaccountId]
    );
    const messageCount = parseInt(msgCount.rows[0].n, 10) || 0;

    // Delete in transaction: messages first, then conversation
    await db.query('BEGIN');
    try {
      await db.query(
        `DELETE FROM conversation_messages WHERE conversation_id = $1 AND subaccount_id = $2`,
        [conversationId, subaccountId]
      );
      await db.query(
        `DELETE FROM conversations WHERE id = $1 AND subaccount_id = $2`,
        [conversationId, subaccountId]
      );
      await db.query('COMMIT');
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.conversation.delete',
      targetType: 'conversation',
      targetId: conversationId,
      targetSubaccountId: subaccountId,
      metadata: {
        contact_id: conv.contact_id,
        channel: conv.channel,
        message_count: messageCount
      }
    });

    return res.status(200).json({ deleted: true, id: conversationId, message_count: messageCount });
  } catch (err) {
    console.error('conversation-delete error:', err);
    return res.status(500).json({ error: 'Failed to delete conversation', detail: err.message });
  }
}

exports.handler = wrap(handler);
