// api/subaccount/subscription-plans-delete.js (Lambda)
// POST /api/subaccount/subscription-plans-delete
// Hard deletes a subscription plan. Admin-only.
// Body: { id }
//
// Database has ON DELETE RESTRICT on subscriptions.plan_id, so this will
// fail with a foreign-key error if any subscription (in any state) still
// references the plan. We pre-check explicitly to give a clean error.
//
// To delete a plan with subscribers, you must first either:
//   1. Cancel all subscriptions on the plan, OR
//   2. Migrate subscriptions to a different plan
// Soft-retiring (active=false) is the recommended path for ongoing customers.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can delete subscription plans' });
  }

  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const existing = await db.query(
      'SELECT * FROM subscription_plans WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Plan not found' });

    // Pre-check: count any subscriptions still referencing this plan.
    // ALL statuses count: active, paused, suspended, cancelled. A cancelled
    // sub still has historical data tied to the plan_name and price; deleting
    // the plan would orphan that history.
    const refs = await db.query(
      'SELECT COUNT(*)::int AS n FROM subscriptions WHERE plan_id = $1',
      [id]
    );
    const refCount = refs.rows[0].n;
    if (refCount > 0) {
      return res.status(409).json({
        error: `Cannot delete plan: ${refCount} subscription${refCount === 1 ? '' : 's'} reference${refCount === 1 ? 's' : ''} this plan. Deactivate the plan instead, or cancel/migrate the subscriptions first.`,
        subscription_count: refCount
      });
    }

    // Audit BEFORE the delete so we have a record even if delete fails.
    // Includes a snapshot of the plan content for compliance.
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan.delete',
      targetType: 'subscription_plan',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        snapshot: {
          name: existing.rows[0].name,
          items: existing.rows[0].items,
          pricing: existing.rows[0].pricing
        }
      }
    });

    await db.query('DELETE FROM subscription_plans WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]);

    return res.status(200).json({ success: true, deleted: id });
  } catch (e) {
    console.error('subscription-plans-delete error:', e.message);
    // Foreign key violation in case the pre-check raced with a new sub
    if (e.code === '23503') {
      return res.status(409).json({
        error: 'Cannot delete plan: subscriptions reference it. Deactivate instead.'
      });
    }
    return res.status(500).json({ error: 'Failed to delete subscription plan' });
  }
}

exports.handler = wrap(handler);
