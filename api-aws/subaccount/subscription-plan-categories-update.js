// api/subaccount/subscription-plan-categories-update.js (Lambda)
// POST /api/subaccount/subscription-plan-categories-update
// Updates an existing category. Admin only.
// Body: { id, name?, sortOrder? }

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can edit plan categories' });
  }

  const b = req.body || {};
  const id = b.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const existing = await db.query(
      'SELECT * FROM subscription_plan_categories WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Category not found' });

    const updates = [];
    const params = [];
    let i = 1;
    if (typeof b.name === 'string') {
      const name = b.name.trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.push(`name = $${i++}`); params.push(name);
    }
    if (b.sortOrder !== undefined) {
      const so = parseInt(b.sortOrder, 10);
      if (!Number.isFinite(so)) return res.status(400).json({ error: 'sortOrder must be an integer' });
      updates.push(`sort_order = $${i++}`); params.push(so);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(id, auth.subaccount_id);
    await db.query(
      `UPDATE subscription_plan_categories SET ${updates.join(', ')} WHERE id = $${i++} AND subaccount_id = $${i++}`,
      params
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan_category.update',
      targetType: 'subscription_plan_category',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { fields_changed: Object.keys(b).filter(k => k !== 'id') }
    });

    const v = await db.query('SELECT * FROM subscription_plan_categories WHERE id = $1', [id]);
    return res.status(200).json({ success: true, category: v.rows[0] });
  } catch (e) {
    console.error('subscription-plan-categories-update error:', e.message);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A category with this name already exists' });
    }
    return res.status(500).json({ error: 'Failed to update category' });
  }
}

exports.handler = wrap(handler);
