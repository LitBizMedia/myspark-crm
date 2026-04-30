// api/agency/subaccount-create.js (Lambda version)
// POST /api/agency/subaccount-create
// Creates subaccounts + subaccount_data + subaccount_plans in a single transaction.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: 'id required' });
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (!b.slug) return res.status(400).json({ error: 'slug required' });
  if (!b.tier) return res.status(400).json({ error: 'tier required' });

  const subId = b.id;
  const slug = b.slug;
  const initData = b.initData || {};

  try {
    // 1. Insert subaccount
    await db.query(`
      INSERT INTO subaccounts (id, agency_id, name, slug, plan, active, admin_email, admin_username, created_at)
      VALUES ($1, 'agency-main', $2, $3, $4, true, $5, $6, NOW())
    `, [subId, b.name, slug, b.tier, b.adminEmail || null, b.adminUsername || null]);

    // 2. Insert initial subaccount_data
    await db.query(`
      INSERT INTO subaccount_data (id, subaccount_id, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
    `, ['data-' + slug, subId, JSON.stringify(initData)]);

    // 3. Insert subaccount_plans
    await db.query(`
      INSERT INTO subaccount_plans (
        subaccount_id, plan_tier, billing_period, hipaa_addon, status,
        exempt_from_billing, discount_percent, discount_note, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (subaccount_id) DO UPDATE SET
        plan_tier = EXCLUDED.plan_tier,
        billing_period = EXCLUDED.billing_period,
        hipaa_addon = EXCLUDED.hipaa_addon,
        status = EXCLUDED.status,
        exempt_from_billing = EXCLUDED.exempt_from_billing,
        discount_percent = EXCLUDED.discount_percent,
        discount_note = EXCLUDED.discount_note,
        updated_at = NOW()
    `, [
      subId, b.tier, b.billingPeriod || 'monthly', !!b.hipaaAddon,
      b.status || 'exempt',
      b.exemptFromBilling !== false,
      parseInt(b.discountPercent) || 0,
      b.discountNote || null
    ]);

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.subaccount.create',
      targetType: 'subaccount',
      targetId: subId,
      targetSubaccountId: subId,
      metadata: { name: b.name, slug, tier: b.tier }
    });

    return res.status(200).json({ success: true, id: subId });
  } catch (e) {
    console.error('subaccount-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subaccount: ' + e.message });
  }
}

exports.handler = wrap(handler);
