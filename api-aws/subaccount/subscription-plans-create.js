// api/subaccount/subscription-plans-create.js (Lambda)
// POST /api/subaccount/subscription-plans-create
// Creates a new subscription plan. Admin-only.
// Body: { id, name, description, items, pricing, notes }
// Validates: name required, at least 1 item, at least 1 pricing cycle enabled with price > 0.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_CYCLES = ['weekly', 'monthly', 'quarterly', 'annual'];

// Validates pricing structure: must have at least one enabled cycle with price > 0.
// Returns null on success, error message string on failure.
function validatePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return 'Pricing is required';
  let enabledCount = 0;
  for (const cycle of VALID_CYCLES) {
    const p = pricing[cycle];
    if (!p) continue;
    if (p.enabled) {
      const price = parseFloat(p.price);
      if (isNaN(price) || price <= 0) {
        return `Cycle "${cycle}" is enabled but has invalid price`;
      }
      enabledCount++;
    }
  }
  if (enabledCount === 0) return 'At least one billing cycle must be enabled with a valid price';
  return null;
}

// Normalize trial_days: accept number or string, clamp to [0, 365], default 0.
// Returns integer.
function parseTrialDays(v) {
  if (v == null || v === '') return 0;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return 0;
  if (n > 365) return 365;
  return n;
}

// Normalize items: ensure each has id, name, taxable defaults.
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, idx) => ({
    id: it.id || `pi-${Date.now()}-${idx}`,
    name: String(it.name || '').trim(),
    description: String(it.description || '').trim(),
    taxable: it.taxable !== false  // default true
  })).filter(it => it.name.length > 0);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  // Plan creation is admin-only (or super_admin). Manager cannot create plans
  // because plans affect all current and future customers.
  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can create subscription plans' });
  }

  const body = req.body || {};
  const id = body.id || `splan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const items = normalizeItems(body.items);  // optional; may be empty
  const pricing = body.pricing || {};
  const categoryId = body.categoryId || null;
  const taxable = body.taxable !== false;
  const trialDays = parseTrialDays(body.trialDays);

  if (!name) return res.status(400).json({ error: 'Plan name is required' });

  const pricingError = validatePricing(pricing);
  if (pricingError) return res.status(400).json({ error: pricingError });

  // Whitelist pricing structure to prevent arbitrary data injection
  const cleanPricing = {};
  for (const cycle of VALID_CYCLES) {
    const p = pricing[cycle];
    cleanPricing[cycle] = {
      enabled: !!(p && p.enabled),
      price: p && p.enabled ? parseFloat(p.price) : 0
    };
  }

  try {
    // Verify category if provided
    if (categoryId) {
      const c = await db.query(
        'SELECT id FROM subscription_plan_categories WHERE id = $1 AND subaccount_id = $2',
        [categoryId, auth.subaccount_id]
      );
      if (!c.rows.length) return res.status(404).json({ error: 'Category not found' });
    }

    await db.query(
      `INSERT INTO subscription_plans (
        id, subaccount_id, name, description, active, items, pricing,
        category_id, taxable, trial_days,
        created_at, updated_at, created_by
      ) VALUES ($1, $2, $3, $4, TRUE, $5::jsonb, $6::jsonb,
                $7, $8, $9,
                NOW(), NOW(), $10)`,
      [id, auth.subaccount_id, name, description, JSON.stringify(items),
       JSON.stringify(cleanPricing), categoryId, taxable, trialDays, auth.user_id]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription_plan.create',
      targetType: 'subscription_plan',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name, category_id: categoryId, taxable, trial_days: trialDays, item_count: items.length }
    });

    const verify = await db.query('SELECT * FROM subscription_plans WHERE id = $1', [id]);
    return res.status(200).json({ success: true, plan: verify.rows[0] });
  } catch (e) {
    console.error('subscription-plans-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subscription plan' });
  }
}

exports.handler = wrap(handler);
