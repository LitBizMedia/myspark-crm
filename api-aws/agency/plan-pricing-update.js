// api/agency/plan-pricing-update.js (Lambda version)
// POST /api/agency/plan-pricing-update
// Bulk upserts plan pricing rows for all tiers.
// Accepts pricing + limits (max_staff, max_contacts, max_emails_per_month, max_sms_per_month).
// NULL = unlimited for any limit field.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

function clampNonNegInt(v) {
  // Returns NULL for empty/null/undefined, otherwise floor of a non-negative integer.
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return null;
  return n;
}

function clampNonNegCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array required' });

  try {
    for (const r of rows) {
      if (!r.id || !r.tier) return res.status(400).json({ error: 'each row needs id and tier' });
      await db.query(`
        INSERT INTO plan_pricing (
          id, tier,
          monthly_cents, annual_cents, hipaa_monthly_cents, hipaa_annual_cents,
          max_staff, max_contacts, max_emails_per_month, max_sms_per_month,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          tier                 = EXCLUDED.tier,
          monthly_cents        = EXCLUDED.monthly_cents,
          annual_cents         = EXCLUDED.annual_cents,
          hipaa_monthly_cents  = EXCLUDED.hipaa_monthly_cents,
          hipaa_annual_cents   = EXCLUDED.hipaa_annual_cents,
          max_staff            = EXCLUDED.max_staff,
          max_contacts         = EXCLUDED.max_contacts,
          max_emails_per_month = EXCLUDED.max_emails_per_month,
          max_sms_per_month    = EXCLUDED.max_sms_per_month,
          updated_at           = NOW()
      `, [
        r.id, r.tier,
        clampNonNegCents(r.monthly_cents),
        clampNonNegCents(r.annual_cents),
        clampNonNegCents(r.hipaa_monthly_cents),
        clampNonNegCents(r.hipaa_annual_cents),
        clampNonNegInt(r.max_staff),
        clampNonNegInt(r.max_contacts),
        clampNonNegInt(r.max_emails_per_month),
        clampNonNegInt(r.max_sms_per_month)
      ]);
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
    return res.status(500).json({ error: 'Failed to update pricing: ' + e.message });
  }
}

exports.handler = wrap(handler);
