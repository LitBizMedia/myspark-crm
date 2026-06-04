// api/agency/plan-pricing-get.js (Lambda version)
// GET /api/agency/plan-pricing-get
// Returns all 4 tier pricing rows including limits, sorted by tier rank.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  try {
    const r = await db.query(`
      SELECT
        id, tier,
        monthly_cents, annual_cents, hipaa_monthly_cents, hipaa_annual_cents,
        max_staff, max_contacts, max_emails_per_month, max_sms_per_month,
        updated_at
      FROM plan_pricing
      ORDER BY
        CASE tier
          WHEN 'starter'      THEN 1
          WHEN 'professional' THEN 2
          WHEN 'business'     THEN 3
          WHEN 'enterprise'   THEN 4
          ELSE 99
        END
    `);
    return res.status(200).json({ rows: r.rows });
  } catch (e) {
    console.error('plan-pricing-get error:', e.message);
    return res.status(500).json({ error: 'Failed to load pricing: ' + e.message });
  }
}

exports.handler = wrap(handler);
