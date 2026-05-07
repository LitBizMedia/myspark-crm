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
// MIGRATED: from Supabase REST fetch to direct pg via lib/db.js.
//
// CHANGED 2026-05-07: TZ-aware. Month-bounds and "today" are computed in the
// subaccount's timezone, so a usage period boundary at midnight Eastern
// doesn't trigger the rollover hours early at midnight UTC.

const db = require('./db');
const { todayInTz, getSubTimezone, DEFAULT_TZ } = require('./timezone');

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
    staff_max:        null,
    contacts_max:     null
  }
};

const DEFAULT_TIER = 'starter';

function getPlanLimits(planTier) {
  const tier = (planTier && PLAN_LIMITS[planTier]) ? planTier : DEFAULT_TIER;
  return PLAN_LIMITS[tier];
}

// Return the first and last day of the current calendar month, anchored to
// the given timezone. Both as YYYY-MM-DD strings.
function currentMonthBoundsInTz(tz) {
  const today = todayInTz(tz || DEFAULT_TZ);
  const [y, m] = today.split('-').map(Number);
  // Last day of the month: day 0 of the next month.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    period_start: `${y}-${pad(m)}-01`,
    period_end:   `${y}-${pad(m)}-${pad(lastDay)}`
  };
}

// Load (or create) the current period's usage row for a subaccount.
async function loadOrCreateUsageRow(subaccountId) {
  const tz = await getSubTimezone(subaccountId, db);
  const today = todayInTz(tz);

  const findResult = await db.query(
    `SELECT * FROM subaccount_usage
     WHERE subaccount_id = $1
       AND period_start <= $2
       AND period_end >= $2
     LIMIT 1`,
    [subaccountId, today]
  );
  if (findResult.rows && findResult.rows.length) {
    return findResult.rows[0];
  }

  const bounds = currentMonthBoundsInTz(tz);
  try {
    const created = await db.insertOne('subaccount_usage', {
      subaccount_id: subaccountId,
      period_start:  bounds.period_start,
      period_end:    bounds.period_end,
      emails_sent:   0,
      sms_sent:      0
    });
    if (created) return created;
  } catch (err) {
    throw new Error('Could not load or create usage row: ' + err.message);
  }

  throw new Error('Could not load or create usage row');
}

async function loadPlanTier(subaccountId) {
  try {
    const row = await db.findOne('subaccount_plans',
      { subaccount_id: subaccountId },
      { select: 'plan_tier, exempt_from_billing' }
    );
    if (!row) return { tier: DEFAULT_TIER, exempt: false };
    return {
      tier:   row.plan_tier || DEFAULT_TIER,
      exempt: !!row.exempt_from_billing
    };
  } catch (err) {
    console.error('plan-limits: loadPlanTier error:', err.message);
    return { tier: DEFAULT_TIER, exempt: false };
  }
}

async function checkAndIncrementUsage(slug, kind) {
  if (!slug) return { ok: false, error: 'slug required', code: 'MISSING_SLUG' };
  if (kind !== 'email' && kind !== 'sms') {
    return { ok: false, error: 'invalid kind', code: 'INVALID_KIND' };
  }

  const subaccountId = 'sub-' + slug;

  const planInfo = await loadPlanTier(subaccountId);

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
    console.error('plan-limits: usage tracking failure for ' + subaccountId + ':', e.message);
    return {
      ok: false,
      error: 'Usage tracking is currently unavailable. Try again in a moment.',
      code: 'USAGE_UNAVAILABLE'
    };
  }

  const currentCount = row[usageField] || 0;

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

  const newCount = currentCount + 1;
  try {
    await db.update('subaccount_usage',
      {
        [usageField]: newCount,
        updated_at: new Date().toISOString()
      },
      { id: row.id }
    );
  } catch (e) {
    console.error('plan-limits: increment failed for ' + subaccountId + ':', e.message);
  }

  return {
    ok: true,
    current: newCount,
    limit:   limit,
    tier:    planInfo.tier,
    kind:    kind
  };
}

async function incrementUsageOnly(subaccountId, kind) {
  try {
    const row = await loadOrCreateUsageRow(subaccountId);
    const usageField = (kind === 'email') ? 'emails_sent' : 'sms_sent';
    const newCount = (row[usageField] || 0) + 1;
    await db.update('subaccount_usage',
      {
        [usageField]: newCount,
        updated_at: new Date().toISOString()
      },
      { id: row.id }
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
