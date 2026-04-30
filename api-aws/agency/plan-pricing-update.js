// api/agency/plan-pricing-update.js (Lambda version)
// POST /api/agency/plan-pricing-update
// Bulk upserts plan pricing rows for all tiers.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array required' });

  try {
    for (const r of rows) {
      if (!r.id || !r.tier) return res.status(400).json({ error: 'each row needs id and tier' });
      await db.query(`
        INSERT INTO plan_pricing (id, tier, monthly_cents, annual_cents, hipaa_monthly_cents, hipaa_annual_cents, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          tier = EXCLUDED.tier,
          monthly_cents = EXCLUDED.monthly_cents,
          annual_cents = EXCLUDED.annual_cents,
          hipaa_monthly_cents = EXCLUDED.hipaa_monthly_cents,
          hipaa_annual_cents = EXCLUDED.hipaa_annual_cents,
          updated_at = NOW()
      `, [r.id, r.tier, r.monthly_cents || 0, r.annual_cents || 0, r.hipaa_monthly_cents || 0, r.hipaa_annual_cents || 0]);
    }

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.plan_pricing.update',
      targetType: 'plan_pricing',
      metadata: { tiers: rows.map(r => r.tier) }
    });

    return res.status(200).json({ success: true, updated: rows.length });
  } catch (e) {
    console.error('plan-pricing-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update pricing' });
  }
}

exports.handler = wrap(handler);
