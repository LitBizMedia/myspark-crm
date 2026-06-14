// api/subaccount/my-plan.js (Lambda version)
//
// GET /api/subaccount/my-plan
//
// Returns the CALLING subaccount's own MySpark+ subscription state for the
// read-only billing panel in settings. Display only; no self-serve actions.
//
// Scope is enforced from the session: a clinic can only ever read its own plan.
// Admin role required (the clinic's vendor cost is admin-level info).
//
// Price resolution mirrors lib/agency-billing calculateCharge precedence exactly,
// so the number shown here equals the number the cron charges, to the cent:
//   exempt        -> effective 0 (with an "upcoming" rate for when exempt ends)
//   custom price  -> that flat amount (discount ignored)
//   discount      -> standard * (1 - pct/100)
//   else          -> standard tier price

const db = require('./lib/db');
const planPricing = require('./lib/plan-pricing');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const TIER_LABELS = {
  starter: 'Studio', professional: 'Practice', business: 'Clinic', enterprise: 'Network'
};
const HIPAA_TIERS = ['professional', 'business', 'enterprise'];

// Resolve a charge amount from the pieces, mirroring calculateCharge precedence.
// Returns cents. customPriceCents wins (discount ignored); else discount on standard.
function resolveCharge(standardCents, customPriceCents, discountPercent) {
  if (customPriceCents !== null && customPriceCents !== undefined && !isNaN(customPriceCents)) {
    return Math.max(0, Math.round(Number(customPriceCents)));
  }
  const pct = Number(discountPercent) || 0;
  if (pct <= 0) return standardCents;
  if (pct >= 100) return 0;
  return Math.round(standardCents * (1 - pct / 100));
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const subaccountId = auth.subaccount_id; // scope from session, never query

  try {
    const planRow = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
    if (!planRow) {
      return res.status(404).json({ error: 'No subscription plan found' });
    }

    const tier = planRow.plan_tier;
    const billingPeriod = planRow.billing_period || 'monthly';
    const status = planRow.status || 'active';
    const isExempt = !!planRow.exempt_from_billing;
    const customPriceCents = planRow.custom_price_cents;
    const discountPercent = planRow.discount_percent || 0;

    // Standard tier price (no HIPAA add-on; HIPAA is tier-included at 0).
    let standardCents = 0;
    try {
      standardCents = await planPricing.getTotalPrice(tier, billingPeriod, false);
    } catch (e) {
      console.error('my-plan: standard price read failed:', e.message);
    }

    // The resolved rate (override/discount/standard). This is what they pay when
    // NOT exempt and NOT trialing. It's also the "upcoming" rate for exempt/trial.
    const resolvedCents = resolveCharge(standardCents, customPriceCents, discountPercent);

    // Effective = what they actually pay right now.
    // Exempt or trialing => 0 today. Otherwise the resolved rate.
    const trialing = (status === 'trialing');
    const effectiveCents = (isExempt || trialing) ? 0 : resolvedCents;

    // pg returns DATE/TIMESTAMP as JS Date objects. Normalize to YYYY-MM-DD.
    function toYMD(d) {
      if (!d) return null;
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(d).slice(0, 10);
    }

    const payload = {
      tier: tier,
      tier_label: TIER_LABELS[tier] || tier,
      billing_period: billingPeriod,
      status: status,
      exempt: isExempt,
      trialing: trialing,
      discount_percent: discountPercent,
      custom_price: (customPriceCents !== null && customPriceCents !== undefined),
      standard_price_cents: standardCents,
      effective_price_cents: effectiveCents,
      // What they'll pay once exempt/trial ends (the resolved rate).
      upcoming_price_cents: resolvedCents,
      trial_ends_at: toYMD(planRow.trial_ends_at),
      next_billing_date: toYMD(planRow.next_billing_date),
      hipaa_included: HIPAA_TIERS.indexOf(tier) >= 0
    };

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.plan.view',
      targetType: 'subaccount_plan',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { tier: tier, status: status, exempt: isExempt }
    });

    return res.status(200).json(payload);
  } catch (e) {
    console.error('my-plan error:', e.message);
    return res.status(500).json({ error: 'Failed to load plan' });
  }
}

exports.handler = wrap(handler);
