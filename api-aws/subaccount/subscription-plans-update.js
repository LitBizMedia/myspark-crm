// api/subaccount/subscription-plans-update.js (Lambda)
// POST /api/subaccount/subscription-plans-update
// Updates an existing subscription plan. Admin-only.
// Body: { id, name?, description?, active?, items?, pricing?, notes? }
//
// IMPORTANT: Editing a plan does NOT affect existing subscribers. Their
// plan_name_snapshot, cycle_price, and items were locked at subscription
// creation. Plan edits only impact NEW subscriptions.
//
// Setting active=false is a soft retire: existing subscribers keep their
// subscription, but the plan can no longer be selected for new subs.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_CYCLES = ['weekly', 'monthly', 'quarterly', 'annual'];

function validatePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return 'Pricing is required';
  let enabledCount = 0;
  for (const cycle of VALID_CYCLES) {
    const p = pricing[cycle];
    if (!p) continue;
    if (p.enabled) {
      const price = parseFloat(p.price);
      if (isNaN(price) || price <= 0) return `Cycle "${cycle}" is enabled but has invalid price`;
      enabledCount++;
    }
  }
  if (enabledCount === 0) return 'At least one billing cycle must be enabled';
  return null;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, idx) => ({
    id: it.id || `pi-${Date.now()}-${idx}`,
    name: String(it.name || '').trim(),
    description: String(it.description || '').trim(),
    taxable: it.taxable !== false
  })).filter(it => it.name.length > 0);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can edit subscription plans' });
  }

  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const existing = await db.query(
      'SELECT * FROM subscription_plans WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Plan not found' });

    // Build a partial update; only include fields present in the request body.
    // This lets the frontend send a small payload (e.g., just toggling active).
    const updates = [];
    const params = [];
    let i = 1;

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.push(`name = $${i++}`); params.push(name);
    }
    if (typeof body.description === 'string') {
      updates.push(`description = $${i++}`); params.push(body.description.trim());
    }
    if (typeof body.notes === 'string') {
      updates.push(`notes = $${i++}`); params.push(body.notes.trim());
    }
    if (typeof body.active === 'boolean') {
      updates.push(`active = $${i++}`); params.push(body.active);
    }
    if (Array.isArray(body.items)) {
      const items = normalizeItems(body.items);
      if (items.length === 0) return res.status(400).json({ error: 'Plan must have at least one item' });
      updates.push(`items = $${i++}::jsonb`); params.push(JSON.stringify(items));
    }
    if (body.pricing) {
      const err = validatePricing(body.pricing);
      if (err) return res.status(400).json({ error: err });
      const cleanPricing = {};
      for (const cycle of VALID_CYCLES) {
        const p = body.pricing[cycle];
        cleanPricing[cycle] = {
          enabled: !!(p && p.enabled),
          price: p && p.enabled ? parseFloat(p.price) : 0
        };
      }
      updates.push(`pricing = $${i++}::jsonb`); params.push(JSON.stringify(cleanPricing));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(id, auth.subaccount_id);
    const sql = `UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = $${i++} AND subaccount_id = $${i++}`;

    await db.query(sql, params);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan.update',
      targetType: 'subscription_plan',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { fields_changed: Object.keys(body).filter(k => k !== 'id') }
    });

    const verify = await db.query('SELECT * FROM subscription_plans WHERE id = $1', [id]);
    return res.status(200).json({ success: true, plan: verify.rows[0] });
  } catch (e) {
    console.error('subscription-plans-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update subscription plan' });
  }
}

exports.handler = wrap(handler);
