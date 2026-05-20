// POST /api/subaccount/automations-delete
// Deletes an automation. CASCADE removes its automation_runs.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const r = await db.query(
      'SELECT id, name, trigger_type, action_type FROM automations WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Automation not found' });

    await db.query(
      'DELETE FROM automations WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.automation.delete',
      targetType: 'automation',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        name: r.rows[0].name,
        trigger_type: r.rows[0].trigger_type,
        action_type: r.rows[0].action_type
      }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('automations-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete automation' });
  }
}

exports.handler = wrap(handler);
