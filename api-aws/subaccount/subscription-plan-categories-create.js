// api/subaccount/subscription-plan-categories-create.js (Lambda)
// POST /api/subaccount/subscription-plan-categories-create
// Creates a new plan category. Admin only (plans are admin-managed).
// Body: { id?, name, sortOrder? }
// UNIQUE (subaccount_id, name) prevents duplicates.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can create plan categories' });
  }

  const b = req.body || {};
  const id = b.id || `spcat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = String(b.name || '').trim();
  const sortOrder = Number.isFinite(parseInt(b.sortOrder, 10)) ? parseInt(b.sortOrder, 10) : 0;

  if (!name) return res.status(400).json({ error: 'Category name is required' });

  try {
    await db.query(
      `INSERT INTO subscription_plan_categories
       (id, subaccount_id, name, sort_order, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)`,
      [id, auth.subaccount_id, name, sortOrder, auth.user_id]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan_category.create',
      targetType: 'subscription_plan_category',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name }
    });

    const v = await db.query('SELECT * FROM subscription_plan_categories WHERE id = $1', [id]);
    return res.status(200).json({ success: true, category: v.rows[0] });
  } catch (e) {
    console.error('subscription-plan-categories-create error:', e.message);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A category with this name already exists' });
    }
    return res.status(500).json({ error: 'Failed to create category' });
  }
}

exports.handler = wrap(handler);
