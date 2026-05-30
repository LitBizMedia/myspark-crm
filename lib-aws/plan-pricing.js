// lib-aws/plan-pricing.js
//
// Canonical helper library for SaaS plan pricing + proration math.
// Used by: swap-plan, change-card, exempt-toggle, subscriptions-charge cron.
//
// Per MySpark-SaaS-Plan-Changes-Spec.md:
// - All prices read from plan_pricing table (never hardcode)
// - Proration formula: (new_price - old_price) * (remaining_days / period_days)
// - All amounts internally in cents (integer)
// - All discount math applied AFTER proration
//
// DO NOT modify without reading the spec.

const db = require('./db');

// Cache plan_pricing rows for the duration of a Lambda invocation.
// plan_pricing changes rarely; refetching per call wastes RDS round-trips.
let _pricingCache = null;
let _pricingCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function loadPricing() {
  const now = Date.now();
  if (_pricingCache && (now - _pricingCacheTime) < CACHE_TTL_MS) return _pricingCache;
  const r = await db.query(
    `SELECT tier, monthly_cents, annual_cents, hipaa_monthly_cents, hipaa_annual_cents
     FROM plan_pricing`
  );
  _pricingCache = {};
  for (const row of r.rows) {
    _pricingCache[row.tier] = row;
  }
  _pricingCacheTime = now;
  return _pricingCache;
}

// Get base price in cents for a tier at a given billing period.
async function getPlanPrice(tier, billingPeriod) {
  const pricing = await loadPricing();
  const p = pricing[tier];
  if (!p) throw new Error('Unknown plan tier: ' + tier);
  if (billingPeriod === 'annual') return parseInt(p.annual_cents) || 0;
  if (billingPeriod === 'monthly') return parseInt(p.monthly_cents) || 0;
  throw new Error('Unknown billing period: ' + billingPeriod);
}

// Get HIPAA add-on price in cents for a billing period.
// HIPAA price is uniform across tiers (read from any tier row).
async function getHipaaPrice(billingPeriod) {
  const pricing = await loadPricing();
  const tiers = Object.keys(pricing);
  if (!tiers.length) throw new Error('No pricing data available');
  const p = pricing[tiers[0]];
  if (billingPeriod === 'annual') return parseInt(p.hipaa_annual_cents) || 0;
  if (billingPeriod === 'monthly') return parseInt(p.hipaa_monthly_cents) || 0;
  throw new Error('Unknown billing period: ' + billingPeriod);
}

// Get the total recurring price (base + HIPAA if applicable) in cents.
async function getTotalPrice(tier, billingPeriod, hipaaAddon) {
  const base = await getPlanPrice(tier, billingPeriod);
  const hipaa = hipaaAddon ? await getHipaaPrice(billingPeriod) : 0;
  return base + hipaa;
}

// Days in a billing period.
function daysInPeriod(billingPeriod) {
  if (billingPeriod === 'monthly') return 30;
  if (billingPeriod === 'annual') return 365;
  throw new Error('Unknown billing period: ' + billingPeriod);
}

// Days between two dates (start inclusive, end exclusive). Returns integer >= 0.
// Accepts ISO strings or Date objects.
function daysBetween(start, end) {
  const s = start instanceof Date ? start : new Date(start);
  const e = end instanceof Date ? end : new Date(end);
  if (isNaN(s) || isNaN(e)) return 0;
  const ms = e.getTime() - s.getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// Classify a plan change as upgrade, downgrade, or same.
// Returns { type: 'upgrade' | 'downgrade' | 'same', priceDelta }
// Where priceDelta is new_total - current_total in cents.
//
// Upgrade: priceDelta > 0 (more money per period)
// Downgrade: priceDelta < 0 (less money per period)
// Same: priceDelta === 0
//
// Special case: billing period swaps always classify based on price delta,
// NOT on the period type itself. Monthly→Annual usually = upgrade because
// the annual price is multi-month. Annual→Monthly = downgrade.
async function classifyChange(opts) {
  // opts: { currentTier, currentBillingPeriod, currentHipaa, newTier, newBillingPeriod, newHipaa }
  const currentPrice = await getTotalPrice(opts.currentTier, opts.currentBillingPeriod, !!opts.currentHipaa);
  const newPrice = await getTotalPrice(opts.newTier, opts.newBillingPeriod, !!opts.newHipaa);
  const priceDelta = newPrice - currentPrice;
  let type;
  if (priceDelta > 0) type = 'upgrade';
  else if (priceDelta < 0) type = 'downgrade';
  else type = 'same';
  return { type, currentPrice, newPrice, priceDelta };
}

// Calculate the proration charge in cents for an immediate upgrade.
// Returns positive integer cents.
//
// Per spec:
//   proration_cents = round((new_price - current_price) * (remaining_days / period_days))
// Then apply discount:
//   final_cents = round(proration_cents * (1 - discount_percent / 100))
//
// Inputs:
//   currentTier, currentBillingPeriod, currentHipaa
//   newTier, newBillingPeriod, newHipaa
//   currentPeriodStart (ISO date or Date)
//   discountPercent (0-100, optional, default 0)
//   asOfDate (optional, defaults to today)
//
// Returns:
//   { prorationCents, finalChargeCents, daysElapsed, remainingDays, periodDays, currentPrice, newPrice }
async function calculateProration(opts) {
  const periodDays = daysInPeriod(opts.currentBillingPeriod);
  const now = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  const start = new Date(opts.currentPeriodStart);
  const daysElapsed = Math.min(periodDays, daysBetween(start, now));
  const remainingDays = Math.max(0, periodDays - daysElapsed);

  const currentPrice = await getTotalPrice(opts.currentTier, opts.currentBillingPeriod, !!opts.currentHipaa);
  const newPrice = await getTotalPrice(opts.newTier, opts.newBillingPeriod, !!opts.newHipaa);

  // For monthly→annual or annual→monthly, the current period is the OLD period,
  // remaining days are in the OLD period. After upgrade, customer starts a fresh
  // cycle of the NEW period type. So proration is the delta-cost for the remaining
  // days in the current cycle, not a full new-cycle prepay.
  // The spec says monthly→annual treats as immediate with a reset cycle, but the
  // proration for the SWAP itself is still (new_price - current_price) * remaining/period.
  const priceDelta = newPrice - currentPrice;
  const prorationRaw = priceDelta * (remainingDays / periodDays);
  const prorationCents = Math.round(prorationRaw);

  const discountPct = Math.max(0, Math.min(100, parseInt(opts.discountPercent) || 0));
  const finalChargeCents = Math.round(prorationCents * (1 - discountPct / 100));

  return {
    prorationCents,
    finalChargeCents,
    daysElapsed,
    remainingDays,
    periodDays,
    currentPrice,
    newPrice,
    priceDelta,
    discountPercent: discountPct
  };
}

// Calculate next_billing_date for a billing period.
// Returns a Date object set to (start + period_days).
function calculateNextBillingDate(startDate, billingPeriod) {
  const start = startDate instanceof Date ? new Date(startDate) : new Date(startDate);
  const days = daysInPeriod(billingPeriod);
  const next = new Date(start.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

// Reset the pricing cache (for tests, or after admin updates plan_pricing).
function clearPricingCache() {
  _pricingCache = null;
  _pricingCacheTime = 0;
}

module.exports = {
  loadPricing,
  getPlanPrice,
  getHipaaPrice,
  getTotalPrice,
  daysInPeriod,
  daysBetween,
  classifyChange,
  calculateProration,
  calculateNextBillingDate,
  clearPricingCache
};
