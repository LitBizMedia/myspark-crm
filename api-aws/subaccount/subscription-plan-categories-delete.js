// api/subaccount/subscription-plan-categories-delete.js (Lambda)
// POST /api/subaccount/subscription-plan-categories-delete
// Deletes a category. Admin only.
// Body: { id }
//
// FK on subscription_plans.category_id is ON DELETE SET NULL, so plans
// referencing this category become uncategorized rather than blocking.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can delete plan categories' });
  }

  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const existing = await db.query(
      'SELECT * FROM subscription_plan_categories WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Category not found' });

    // Count affected plans for audit metadata
    const affected = await db.query(
      'SELECT COUNT(*)::int AS n FROM subscription_plans WHERE category_id = $1',
      [id]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan_category.delete',
      targetType: 'subscription_plan_category',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        snapshot: { name: existing.rows[0].name },
        affected_plan_count: affected.rows[0].n
      }
    });

    await db.query(
      'DELETE FROM subscription_plan_categories WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );

    return res.status(200).json({
      success: true,
      deleted: id,
      affected_plan_count: affected.rows[0].n
    });
  } catch (e) {
    console.error('subscription-plan-categories-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete category' });
  }
}

exports.handler = wrap(handler);
