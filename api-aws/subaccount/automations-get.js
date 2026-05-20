// GET or POST /api/subaccount/automations-get
// Returns one automation plus its recent run history.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function rowToCamel(r) {
  if (!r) return null;
  return {
    id: r.id,
    subaccountId: r.subaccount_id,
    name: r.name,
    description: r.description,
    active: r.active,
    triggerType: r.trigger_type,
    triggerConfig: r.trigger_config || {},
    actionType: r.action_type,
    actionConfig: r.action_config || {},
    idempotencyRule: r.idempotency_rule,
    idempotencyWindowDays: r.idempotency_window_days,
    isTransactional: r.is_transactional,
    totalRuns: r.total_runs,
    lastRanAt: r.last_ran_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by
  };
}

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const id = (req.query && req.query.id) || (req.body && req.body.id);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const r = await db.query(
      'SELECT * FROM automations WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Automation not found' });

    const runs = await db.query(
      'SELECT id, contact_id, target_ref, ran_at, status, error_message ' +
      'FROM automation_runs WHERE automation_id = $1 ORDER BY ran_at DESC LIMIT 20',
      [id]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.automation.view',
      targetType: 'automation',
      targetId: id,
      targetSubaccountId: auth.subaccount_id
    });

    return res.status(200).json({
      success: true,
      automation: rowToCamel(r.rows[0]),
      recent_runs: runs.rows
    });
  } catch (e) {
    console.error('automations-get error:', e.message);
    return res.status(500).json({ error: 'Failed to load automation' });
  }
}

exports.handler = wrap(handler);
