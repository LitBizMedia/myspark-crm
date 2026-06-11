// api/subaccount/subscription-plans-list.js (Lambda)
// GET /api/subaccount/subscription-plans-list[?active_only=true]
// Returns all subscription plans for the authenticated subaccount.
// Allowed for any authenticated subaccount user (read access).
// Frontend uses this to populate the catalog admin page AND the plan picker
// in the subscription create modal.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { POWER_UP } = require('./lib/roles');
const { wrap } = require('./lib/lambda-adapter');

function rowToPlan(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    active: row.active,
    categoryId: row.category_id || null,
    taxable: row.taxable !== false,
    items: row.items || [],
    pricing: row.pricing || {},
    trialDays: parseInt(row.trial_days, 10) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: POWER_UP });
  if (!auth) return;

  const activeOnly = req.query && (req.query.active_only === 'true' || req.query.active_only === '1');

  try {
    const sql = activeOnly
      ? 'SELECT * FROM subscription_plans WHERE subaccount_id = $1 AND active = TRUE ORDER BY name ASC'
      : 'SELECT * FROM subscription_plans WHERE subaccount_id = $1 ORDER BY active DESC, name ASC';

    const result = await db.query(sql, [auth.subaccount_id]);

    return res.status(200).json({
      success: true,
      plans: result.rows.map(rowToPlan)
    });
  } catch (e) {
    console.error('subscription-plans-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load subscription plans' });
  }
}

exports.handler = wrap(handler);
