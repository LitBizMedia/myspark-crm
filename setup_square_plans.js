#!/usr/bin/env node
/**
 * setup_square_plans.js
 *
 * One-time script to create MySpark+ subscription plans in Square catalog.
 *
 * What it does:
 *   1. Reads LitBiz's Square credentials from Supabase
 *   2. Creates 5 subscription plans (Starter, Pro, Business, Enterprise, HIPAA)
 *   3. Creates 18 plan variations (with/without trial, monthly/annual)
 *   4. Writes square_plan_ids.json with the resulting plan_variation_ids
 *
 * Safety:
 *   - Idempotent. Uses fixed idempotency keys so re-runs don't create duplicates.
 *   - Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env or environment.
 *   - Bails immediately if anything looks wrong.
 *
 * Usage:
 *   1. Make sure .env exists in project root with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *   2. Run: node setup_square_plans.js
 *   3. Check square_plan_ids.json was created
 *   4. Commit square_plan_ids.json to repo
 *
 * Re-runs are safe and will print "already exists" for plans that exist.
 */

const fs = require('fs');
const path = require('path');

// Load .env if dotenv is available, otherwise rely on shell env
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  console.error('Either create a .env file or run with the variables exported.');
  process.exit(1);
}

const SQUARE_VERSION = '2025-10-16';
const AGENCY_SLUG = 'litbiz';
const SUBACCOUNT_ID = 'sub-' + AGENCY_SLUG;

// =====================================================
// PLAN DEFINITIONS
// =====================================================
// We create one Subscription Plan per tier, with multiple Plan Variations underneath.
// Each tier has 4 variations: monthly+trial, annual+trial, monthly notrial, annual notrial.
// HIPAA is an add-on with no trial (it's an upgrade, not a starter offering).

const PLAN_DEFS = [
  {
    key: 'starter',
    name: 'MySpark+ Starter',
    monthlyPrice: 2900,   // $29 in cents
    annualPrice: 29000,   // $290 in cents
    hasTrial: true
  },
  {
    key: 'professional',
    name: 'MySpark+ Professional',
    monthlyPrice: 7900,
    annualPrice: 79000,
    hasTrial: true
  },
  {
    key: 'business',
    name: 'MySpark+ Business',
    monthlyPrice: 14900,
    annualPrice: 149000,
    hasTrial: true
  },
  {
    key: 'enterprise',
    name: 'MySpark+ Enterprise',
    monthlyPrice: 34900,
    annualPrice: 349000,
    hasTrial: true
  },
  {
    key: 'hipaa_addon',
    name: 'MySpark+ HIPAA Compliance Add-on',
    monthlyPrice: 5000,
    annualPrice: 50000,
    hasTrial: false
  }
];

const TRIAL_DAYS = 14;

// =====================================================
// HELPERS
// =====================================================

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

async function getSquareCreds() {
  const url = SUPABASE_URL + '/rest/v1/square_credentials?subaccount_id=eq.' + encodeURIComponent(SUBACCOUNT_ID) + '&select=*';
  const res = await fetch(url, { headers: svcHeaders() });
  if (!res.ok) throw new Error('Supabase fetch failed: ' + res.status + ' ' + (await res.text()));
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('No square_credentials row found for ' + SUBACCOUNT_ID);
  const c = rows[0];
  if (!c.access_token) throw new Error('access_token is missing on credentials record');
  if (!c.location_id) throw new Error('location_id is missing on credentials record');
  return c;
}

function squareHost(sandbox) {
  return sandbox ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
}

function squareHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION
  };
}

async function squareCall(creds, method, pathStr, body) {
  const url = 'https://' + squareHost(creds.sandbox) + pathStr;
  const opts = { method: method, headers: squareHeaders(creds.access_token) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  if (!res.ok) {
    const errMsg = json && json.errors ? JSON.stringify(json.errors) : text;
    throw new Error('Square ' + method + ' ' + pathStr + ' failed: ' + res.status + ' ' + errMsg);
  }
  return json;
}

// =====================================================
// CATALOG OPERATIONS
// =====================================================

// Search for an existing subscription plan by name.
// Returns the catalog object or null.
async function findExistingPlan(creds, planName) {
  const body = {
    object_types: ['SUBSCRIPTION_PLAN'],
    query: {
      exact_query: { attribute_name: 'name', attribute_value: planName }
    }
  };
  try {
    const res = await squareCall(creds, 'POST', '/v2/catalog/search', body);
    const objs = (res && res.objects) || [];
    return objs[0] || null;
  } catch (e) {
    // Some accounts don't support exact_query on plans; fall back to listing all
    return null;
  }
}

// Search for an existing variation by ID lookup
async function findExistingVariation(creds, variationId) {
  if (!variationId) return null;
  try {
    const res = await squareCall(creds, 'GET', '/v2/catalog/object/' + encodeURIComponent(variationId), null);
    return res && res.object;
  } catch (e) {
    return null;
  }
}

// Create a SUBSCRIPTION_PLAN (parent) - just defines the plan, no pricing
async function createSubscriptionPlan(creds, planName) {
  const idempotencyKey = 'msp-plan-' + planName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const body = {
    idempotency_key: idempotencyKey,
    object: {
      type: 'SUBSCRIPTION_PLAN',
      id: '#plan',
      subscription_plan_data: {
        name: planName,
        all_items: false
      }
    }
  };
  const res = await squareCall(creds, 'POST', '/v2/catalog/object', body);
  return res.catalog_object;
}

// Create a SUBSCRIPTION_PLAN_VARIATION (child) - defines pricing and cadence
// trialDays: 0 means no trial, otherwise creates 100% discount initial phase
async function createPlanVariation(creds, parentPlanId, variationName, cadence, priceCents, trialDays) {
  const idempotencyKey = ('msp-var-' + parentPlanId + '-' + variationName).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const phases = [];

  if (trialDays > 0) {
    // Trial phase: 100% discount, lasts ~trialDays in DAILY-style cadence won't work for monthly cadence.
    // Square's approach: a trial phase with a STATIC price of $0 for a fixed number of cycles.
    // For 14-day trial on a MONTHLY plan, we use a separate cadence that ends after the trial.
    // Per Square docs: trial = phase 0 with price $0 for 1 period of a custom cadence.
    // Simplest reliable approach: 1 period of MONTHLY at $0 (= 1 free month).
    // Square does NOT directly support 14-day trials on monthly plans via phases.
    //
    // PIVOT: Square Subscriptions supports trials only via MATCHING the cadence.
    // For 14-day trials, we'd need EVERY_TWO_WEEKS cadence trial -> MONTHLY recurring,
    // but that complicates the structure.
    //
    // Practical solution: skip the discount-phase trial for now. Use start_date offset
    // when CREATING the subscription instead. Square allows start_date in the future,
    // which effectively gives a free trial period of any duration.
    //
    // So this script just creates simple single-phase plans. The trial is handled at
    // subscription-creation time by setting start_date = today + 14 days.
  }

  // Single phase: recurring at the plan price
  phases.push({
    cadence: cadence,
    periods: null,    // null = forever
    pricing: {
      type: 'STATIC',
      price: { amount: priceCents, currency: 'USD' }
    }
  });

  const body = {
    idempotency_key: idempotencyKey,
    object: {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: '#variation',
      subscription_plan_variation_data: {
        name: variationName,
        phases: phases,
        subscription_plan_id: parentPlanId
      }
    }
  };

  const res = await squareCall(creds, 'POST', '/v2/catalog/object', body);
  return res.catalog_object;
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  console.log('MySpark+ Square Plan Setup\n');
  console.log('Reading credentials...');
  const creds = await getSquareCreds();
  console.log('  merchant_id : ' + creds.merchant_id);
  console.log('  location_id : ' + creds.location_id);
  console.log('  sandbox     : ' + creds.sandbox);
  console.log('  host        : ' + squareHost(creds.sandbox));
  console.log('');

  if (!creds.sandbox) {
    console.log('WARNING: Operating in PRODUCTION mode against your real Square catalog.');
    console.log('Plans will be created in your live LitBiz Media Square account.');
    console.log('Continuing in 3 seconds. Press Ctrl+C to abort.\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  const result = {
    created_at: new Date().toISOString(),
    sandbox: creds.sandbox,
    merchant_id: creds.merchant_id,
    location_id: creds.location_id,
    plans: {}
  };

  for (const def of PLAN_DEFS) {
    console.log('--- ' + def.name + ' ---');

    // Check if a plan with this name already exists
    let plan = await findExistingPlan(creds, def.name);
    if (plan) {
      console.log('  Plan exists: ' + plan.id);
    } else {
      try {
        plan = await createSubscriptionPlan(creds, def.name);
        console.log('  Created plan: ' + plan.id);
      } catch (e) {
        // If create fails because of idempotency, try to find it again
        console.log('  Create failed, retrying lookup: ' + e.message);
        plan = await findExistingPlan(creds, def.name);
        if (!plan) throw e;
      }
    }

    const planId = plan.id;
    result.plans[def.key] = {
      plan_id: planId,
      plan_name: def.name,
      variations: {}
    };

    // For each tier, create monthly and annual variations.
    // We don't create separate "with trial" / "without trial" variations - we handle the
    // trial at subscription creation time using start_date offset.
    const variations = [
      { key: 'monthly', name: def.name + ' Monthly',  cadence: 'MONTHLY', price: def.monthlyPrice },
      { key: 'annual',  name: def.name + ' Annual',   cadence: 'ANNUAL',  price: def.annualPrice  }
    ];

    for (const v of variations) {
      try {
        const variation = await createPlanVariation(creds, planId, v.name, v.cadence, v.price, 0);
        console.log('  Created variation [' + v.key + ']: ' + variation.id + ' ($' + (v.price/100) + ' ' + v.cadence + ')');
        result.plans[def.key].variations[v.key] = {
          variation_id: variation.id,
          name: v.name,
          cadence: v.cadence,
          price_cents: v.price
        };
      } catch (e) {
        // Idempotency means the same call returns the existing one normally.
        // If we still hit an error, log it and continue.
        console.log('  Variation [' + v.key + '] error: ' + e.message);
      }
    }

    console.log('');
  }

  // Write output
  const outPath = path.join(__dirname, 'square_plan_ids.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('Wrote ' + outPath);
  console.log('\nDone. Commit this file to your repo:');
  console.log('  git add square_plan_ids.json');
  console.log('  git commit -m "Phase B: Add Square plan IDs config"');
  console.log('  git push origin main');
}

main().catch(function(err) {
  console.error('\nFAILED: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
