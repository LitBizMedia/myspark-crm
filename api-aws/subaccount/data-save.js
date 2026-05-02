// api/subaccount/data-save.js (Lambda version)
// POST /api/subaccount/data-save
// Saves the bulk subaccount_data JSONB blob for the authenticated subaccount.
//
// User-related fields are stripped before save. The canonical sources are:
//   - subaccount_users table (users, admin)
//   - server-side config (Supabase fields are dead, no longer used)
// Anything still being sent in the blob is treated as legacy noise and dropped.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

// Top-level fields that must NOT live in the blob anymore.
const STRIPPED_TOP_LEVEL = ['users', '_subaccountAdmin'];
// Fields under data.settings that must NOT live in the blob anymore.
const STRIPPED_SETTINGS = ['adminProfile', 'supabaseUrl', 'supabaseKey'];

function sanitize(data) {
  // Shallow copy so we don't mutate caller's object.
  const out = { ...data };
  const stripped = [];

  for (const k of STRIPPED_TOP_LEVEL) {
    if (k in out) {
      delete out[k];
      stripped.push(k);
    }
  }

  if (out.settings && typeof out.settings === 'object') {
    out.settings = { ...out.settings };
    for (const k of STRIPPED_SETTINGS) {
      if (k in out.settings) {
        delete out.settings[k];
        stripped.push('settings.' + k);
      }
    }
  }

  return { data: out, stripped };
}

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

  // Strip dead user-related fields before persisting.
  const { data: clean, stripped } = sanitize(data);
  if (stripped.length > 0) {
    console.log(`data-save[${subaccountId}]: stripped legacy fields: ${stripped.join(', ')}`);
  }

  try {
    await db.query(`
      INSERT INTO subaccount_data (id, subaccount_id, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = NOW()
      WHERE subaccount_data.subaccount_id = $2
    `, [dataId, subaccountId, JSON.stringify(clean)]);

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('data-save error:', e.message);
    return res.status(500).json({ error: 'Failed to save data' });
  }
}

exports.handler = wrap(handler);
