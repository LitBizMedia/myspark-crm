// api/subaccount/subscription-plan-categories-list.js (Lambda)
// GET /api/subaccount/subscription-plan-categories-list
// Returns all plan categories for the subaccount, sorted.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { POWER_UP } = require('./lib/roles');
const { wrap } = require('./lib/lambda-adapter');

function rowToCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: POWER_UP });
  if (!auth) return;

  try {
    const result = await db.query(
      'SELECT * FROM subscription_plan_categories WHERE subaccount_id = $1 ORDER BY sort_order ASC, name ASC',
      [auth.subaccount_id]
    );
    return res.status(200).json({ success: true, categories: result.rows.map(rowToCategory) });
  } catch (e) {
    console.error('subscription-plan-categories-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load categories' });
  }
}

exports.handler = wrap(handler);
