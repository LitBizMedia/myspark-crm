// POST /api/subaccount/resources-reorder
// Body: { ordered_ids: [...] }
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const ids = (req.body && Array.isArray(req.body.ordered_ids)) ? req.body.ordered_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ordered_ids is required' });

    for (let i = 0; i < ids.length; i++) {
      await db.query(
        `UPDATE resources SET display_order = $1, updated_at = NOW()
         WHERE id = $2 AND subaccount_id = $3`,
        [i, ids[i], auth.subaccount_id]
      );
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('resources-reorder error:', e.message);
    return res.status(500).json({ error: 'Failed to reorder resources' });
  }
}
exports.handler = wrap(handler);
