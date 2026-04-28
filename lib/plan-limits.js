// lib/plan-limits.js
//
// Per-tier monthly limits for email and SMS, plus the usage check function
// called by send endpoints to enforce them.
//
// Usage tracking lives in the subaccount_usage table:
//   { subaccount_id, period_start, period_end, emails_sent, sms_sent }
// Periods align with the subaccount's billing period_start/period_end. When
// the current period rolls over (period_end has passed), this module creates
// the next period's row on first use of the new period.
//
// Public API:
//   getPlanLimits(planTier)       → { emails_per_month, sms_per_month, ... }
//   checkAndIncrementUsage(slug, kind) → { ok, current, limit, error?, code? }
//     kind: 'email' | 'sms'
//     Returns ok:true and increments if under limit.
//     Returns ok:false with error if over limit, no increment.
//
// Pattern: checkAndIncrement is atomic-ish at the application layer. We
// check, then increment in the same call. Concurrent requests could
// theoretically slip through (race), but that's acceptable for a soft cap.
// Worst case is a customer sending a few extra over the limit in a burst.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Limits per tier. Used at send time to gate /api/email/send and /api/sms/send.
// HIPAA addon does NOT change limits - it's about handling, not volume.
const PLAN_LIMITS = {
  starter: {
    emails_per_month: 2000,
    sms_per_month:    300,
    staff_max:        7,
    contacts_max:     10000
  },
  professional: {
    emails_per_month: 15000,
    sms_per_month:    1000,
    staff_max:        15,
    contacts_max:     20000
  },
  business: {
    emails_per_month: 75000,
    sms_per_month:    4000,
    staff_max:        40,
    contacts_max:     40000
  },
  enterprise: {
    emails_per_month: 100000,
    sms_per_month:    8000,
    staff_max:        null,    // null = unlimited
    contacts_max:     null
  }
};

// Default to starter limits if tier is unknown - errs on the safe side
// (lower limits) so a misconfigured subaccount doesn't get unlimited usage.
const DEFAULT_TIER = 'starter';

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function getPlanLimits(planTier) {
  const tier = (planTier && PLAN_LIMITS[planTier]) ? planTier : DEFAULT_TIER;
  return PLAN_LIMITS[tier];
}

// Compute period bounds for "this calendar month" if the subaccount has no
// active row. We use calendar month rather than billing-cycle anchored to
// next_billing_date because billing dates can shift on plan changes/retries
// and that would create gaps in usage tracking.
function currentMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    period_start: start.toISOString().split('T')[0],
    period_end:   end.toISOString().split('T')[0]
  };
}

// Load (or create) the current period's usage row for a subaccount.
async function loadOrCreateUsageRow(subaccountId) {
  const today = new Date().toISOString().split('T')[0];

  // Find the row whose period covers today
  const findUrl = SUPABASE_URL
    + '/rest/v1/subaccount_usage'
    + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
    + '&period_start=lte.' + today
    + '&period_end=gte.' + today
    + '&select=*&limit=1';
  const findRes = await fetch(findUrl, { headers: sbHeaders() });
  if (findRes.ok) {
    const rows = await findRes.json();
    if (rows && rows.length) return rows[0];
  }

  // No active row, create one for current calendar month
  const bounds = currentMonthBounds();
  const insertRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_usage', {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      subaccount_id: subaccountId,
      period_start:  bounds.period_start,
      period_end:    bounds.period_end,
      emails_sent:   0,
      sms_sent:      0
    })
  });
  if (insertRes.ok) {
    const created = await insertRes.json();
    return Array.isArray(created) ? created[0] : created;
  }

  // Could not create - throw so caller knows tracking is broken (and can
  // decide to fail open or fail closed). We fail closed in checkAndIncrement.
  throw new Error('Could not load or create usage row: ' + await insertRes.text());
}

// Look up the subaccount's current plan to know which limits apply.
async function loadPlanTier(subaccountId) {
  const url = SUPABASE_URL
    + '/rest/v1/subaccount_plans'
    + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
    + '&select=plan_tier,exempt_from_billing&limit=1';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return { tier: DEFAULT_TIER, exempt: false };
  const rows = await r.json();
  if (!rows || !rows.length) return { tier: DEFAULT_TIER, exempt: false };
  return {
    tier:   rows[0].plan_tier || DEFAULT_TIER,
    exempt: !!rows[0].exempt_from_billing
  };
}

// Main entry point. Called by send endpoints before they actually send.
// On success, increments the counter and returns ok:true.
// On limit reached, returns ok:false with details.
//
// kind: 'email' or 'sms'
// slug: subaccount slug (e.g. 'litbiz')
async function checkAndIncrementUsage(slug, kind) {
  if (!slug) return { ok: false, error: 'slug required', code: 'MISSING_SLUG' };
  if (kind !== 'email' && kind !== 'sms') {
    return { ok: false, error: 'invalid kind', code: 'INVALID_KIND' };
  }

  const subaccountId = 'sub-' + slug;

  // Load the plan tier
  const planInfo = await loadPlanTier(subaccountId);

  // Exempt subaccounts (LitBiz, paid_by_other comp accounts) bypass limits.
  // Still increment the counter so we have visibility, but don't block.
  if (planInfo.exempt) {
    await incrementUsageOnly(subaccountId, kind);
    return { ok: true, current: null, limit: null, exempt: true };
  }

  const limits = getPlanLimits(planInfo.tier);
  const limitField = (kind === 'email') ? 'emails_per_month' : 'sms_per_month';
  const usageField = (kind === 'email') ? 'emails_sent' : 'sms_sent';
  const limit = limits[limitField];

  let row;
  try {
    row = await loadOrCreateUsageRow(subaccountId);
  } catch (e) {
    // Fail closed: if we can't track usage, refuse the send. Better to be
    // overly cautious with paid resources than allow unbounded sending.
    console.error('plan-limits: usage tracking failure for ' + subaccountId + ':', e.message);
    return {
      ok: false,
      error: 'Usage tracking is currently unavailable. Try again in a moment.',
      code: 'USAGE_UNAVAILABLE'
    };
  }

  const currentCount = row[usageField] || 0;

  // Limit check. null limit = unlimited (Enterprise tier for some kinds).
  if (limit !== null && currentCount >= limit) {
    return {
      ok: false,
      error: 'Monthly ' + kind + ' limit reached for plan ' + planInfo.tier + '. Upgrade your plan to send more.',
      code: 'LIMIT_REACHED',
      current: currentCount,
      limit:   limit,
      tier:    planInfo.tier,
      kind:    kind
    };
  }

  // Increment the counter
  const newCount = currentCount + 1;
  const updateRes = await fetch(
    SUPABASE_URL + '/rest/v1/subaccount_usage?id=eq.' + encodeURIComponent(row.id),
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        [usageField]: newCount,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!updateRes.ok) {
    // Increment failed but we already validated the send is allowed. Log
    // and return ok so the user's send still goes through. Worst case is
    // we miss one usage tick.
    console.error('plan-limits: increment failed for ' + subaccountId + ':', await updateRes.text());
  }

  return {
    ok: true,
    current: newCount,
    limit:   limit,
    tier:    planInfo.tier,
    kind:    kind
  };
}

// Helper for exempt subaccounts: increment without limit checking.
async function incrementUsageOnly(subaccountId, kind) {
  try {
    const row = await loadOrCreateUsageRow(subaccountId);
    const usageField = (kind === 'email') ? 'emails_sent' : 'sms_sent';
    const newCount = (row[usageField] || 0) + 1;
    await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_usage?id=eq.' + encodeURIComponent(row.id),
      {
        method: 'PATCH',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          [usageField]: newCount,
          updated_at: new Date().toISOString()
        })
      }
    );
  } catch (e) {
    console.error('incrementUsageOnly failed:', e.message);
  }
}

module.exports = {
  PLAN_LIMITS,
  DEFAULT_TIER,
  getPlanLimits,
  checkAndIncrementUsage
};
