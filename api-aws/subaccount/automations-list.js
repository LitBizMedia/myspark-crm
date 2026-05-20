// GET /api/subaccount/automations-list
// Lists automations for the authed subaccount.
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
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const r = await db.query(
      'SELECT * FROM automations WHERE subaccount_id = $1 ORDER BY created_at DESC',
      [auth.subaccount_id]
    );
    const automations = r.rows.map(rowToCamel);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.automation.list',
      targetType: 'automation',
      targetSubaccountId: auth.subaccount_id,
      metadata: { count: automations.length }
    });

    return res.status(200).json({ success: true, automations });
  } catch (e) {
    console.error('automations-list error:', e.message);
    return res.status(500).json({ error: 'Failed to list automations' });
  }
}

exports.handler = wrap(handler);
