// api/subaccount/data-save.js (Lambda version)
// POST /api/subaccount/data-save
// Saves the bulk subaccount_data JSONB blob for the authenticated subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data is required' });
  }

  const subaccountId = auth.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');
  const dataId = 'data-' + slug;

  try {
    await db.query(`
      INSERT INTO subaccount_data (id, subaccount_id, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = NOW()
      WHERE subaccount_data.subaccount_id = $2
    `, [dataId, subaccountId, JSON.stringify(data)]);

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('data-save error:', e.message);
    return res.status(500).json({ error: 'Failed to save data' });
  }
}

exports.handler = wrap(handler);
