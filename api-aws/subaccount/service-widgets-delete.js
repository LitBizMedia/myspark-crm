// POST /api/subaccount/service-widgets-delete
// Deletes a service_widgets row scoped to the caller's subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  if (!body.id || typeof body.id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const result = await db.query(
      'DELETE FROM service_widgets WHERE id = $1 AND subaccount_id = $2 RETURNING name',
      [body.id, subaccountId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'widget not found' });
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_widget.delete',
      targetType: 'service_widget', targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: { name: result.rows[0].name }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('service-widgets-delete error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to delete widget' });
  }
}

exports.handler = wrap(handler);
