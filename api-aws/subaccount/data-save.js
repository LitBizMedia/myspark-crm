// api/subaccount/data-save.js (Lambda version)
// POST /api/subaccount/data-save
// Saves the bulk subaccount_data JSONB blob for the authenticated subaccount.
//
// Stripped fields go to dedicated tables/columns:
//   - users, _subaccountAdmin -> subaccount_users table
//   - serviceCategories -> subaccount_data.service_categories column
//   - serviceWidgets -> service_widgets table
//   - payments -> payments table (via /payments-create and /payments-update)
//   - subscriptionPlans -> subscription_plans table (via /subscription-plans-* endpoints)
//   - subscriptions -> subscriptions table (via /subscriptions-* endpoints)
//   - settings.adminProfile -> dead, not used
// Anything still being sent in the blob is treated as legacy noise and dropped.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

// Frontend uses _buildBlobPayload() allowlist + self-healing localStorage to
// ensure only legitimate TIER 2/TIER 3 keys are sent. This server-side strip
// is empty by design. If keys start showing up here, something on the
// frontend regressed.
const STRIPPED_TOP_LEVEL = ['contacts', 'creditBalance', 'creditHistory'];
// Settings keys are managed by frontend allowlist + self-heal. Empty by design.
const STRIPPED_SETTINGS = [];

function sanitize(data) {
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

    // Audit: bulk PHI write. Log stripped keys so we can spot frontend drift.
    try {
      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: 'subaccount.data.bulk_save',
        targetType: 'bulk_data',
        targetSubaccountId: subaccountId,
        metadata: {
          contact_count: (clean.contacts || []).length,
          stripped_keys: stripped,
          payload_keys: Object.keys(clean)
        }
      });
    } catch (e) { console.warn('audit log failed (data-save):', e.message); }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('data-save error:', e.message);
    return res.status(500).json({ error: 'Failed to save data' });
  }
}

exports.handler = wrap(handler);
