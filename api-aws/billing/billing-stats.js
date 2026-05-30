// api/billing/billing-stats.js
//
// GET /api/billing/billing-stats
//
// Returns aggregate SaaS billing stats for the agency Billing tab.
// Stat cards: MRR, Active count, Trialing count, Past Due count.
//
// MRR math: sum monthly-equivalent revenue across active non-exempt plans.
// Annual plans normalize as (annual_cents / 12). Discount percent applied.
// HIPAA addon included when subscribed.
//
// All counts exclude exempt subaccounts (they pay nothing).

const db = require('./lib/db');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;

  try {
    // MRR calculation: monthly-equivalent revenue across active non-exempt plans
    const mrrResult = await db.query(`
      SELECT COALESCE(SUM(
        CASE
          WHEN sp.billing_period = 'monthly' THEN
            pp.monthly_cents + (CASE WHEN sp.hipaa_addon THEN pp.hipaa_monthly_cents ELSE 0 END)
          WHEN sp.billing_period = 'annual' THEN
            (pp.annual_cents / 12) + (CASE WHEN sp.hipaa_addon THEN pp.hipaa_annual_cents / 12 ELSE 0 END)
          ELSE 0
        END * (100 - COALESCE(sp.discount_percent, 0)) / 100
      ), 0) AS mrr_cents
      FROM subaccount_plans sp
      JOIN plan_pricing pp ON pp.tier = sp.plan_tier
      WHERE sp.status = 'active'
        AND sp.exempt_from_billing = false
    `);
    const mrrCents = parseInt(mrrResult.rows[0].mrr_cents) || 0;

    // Status counts
    const countsResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND exempt_from_billing = false) AS active_count,
        COUNT(*) FILTER (WHERE status = 'trialing') AS trialing_count,
        COUNT(*) FILTER (WHERE status = 'past_due') AS past_due_count,
        COUNT(*) FILTER (WHERE exempt_from_billing = true) AS exempt_count,
        COUNT(*) AS total_count
      FROM subaccount_plans
    `);
    const counts = countsResult.rows[0];

    return res.status(200).json({
      mrr_cents: mrrCents,
      active_count: parseInt(counts.active_count) || 0,
      trialing_count: parseInt(counts.trialing_count) || 0,
      past_due_count: parseInt(counts.past_due_count) || 0,
      exempt_count: parseInt(counts.exempt_count) || 0,
      total_count: parseInt(counts.total_count) || 0
    });

  } catch (e) {
    console.error('billing-stats error:', e.message);
    return res.status(500).json({ error: 'Failed to load billing stats: ' + e.message });
  }
}

exports.handler = wrap(handler);
