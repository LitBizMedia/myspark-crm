// api/billing/setup-billing.js
// Called from agency dashboard when creating a new non-exempt subaccount.
// Finds or creates a Square customer, saves card on file, and writes billing
// info to subaccount_plans. Does NOT charge the card yet (14-day trial).

const { findOrCreateCustomer, saveCardOnFile, calculateCharge } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');
const { logAudit, extractActorFromBody } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const {
    subaccountSlug,
    subaccountName,
    adminEmail,
    adminName,
    sourceId,
    existingCustomerId,
    existingCardId,
    tier,
    billingPeriod,
    hipaaAddon,
    discountPercent,
    discountNote,
    skipTrial
  } = req.body || {};

  const actor = extractActorFromBody(req.body);

  const hasNewCard = !!sourceId;
  const hasExistingCard = !!(existingCustomerId && existingCardId);
  if (!subaccountSlug || (!hasNewCard && !hasExistingCard) || !tier || !billingPeriod || !adminEmail) {
    return sendError(res, 400, 'Missing required fields: subaccountSlug, (sourceId or existingCustomerId+existingCardId), tier, billingPeriod, adminEmail');
  }
  if (!['starter', 'professional', 'business', 'enterprise'].includes(tier)) {
    return sendError(res, 400, 'Invalid tier: ' + tier);
  }
  if (!['monthly', 'annual'].includes(billingPeriod)) {
    return sendError(res, 400, 'Invalid billingPeriod: ' + billingPeriod);
  }

  const subaccountId = 'sub-' + subaccountSlug;

  try {
    // 1. Get or create Square customer + card
    let customerId, cardId, cardLast4 = '', cardBrand = '';
    let cardSource = hasExistingCard ? 'existing' : 'new';

    if (hasExistingCard) {
      customerId = existingCustomerId;
      cardId = existingCardId;
    } else {
      const nameParts = (adminName || subaccountName || 'Customer').split(' ');
      const givenName = nameParts[0] || '';
      const familyName = nameParts.slice(1).join(' ') || '';
      const customer = await findOrCreateCustomer({
        givenName,
        familyName,
        emailAddress: adminEmail,
        referenceId: subaccountId
      });
      const card = await saveCardOnFile(customer.id, sourceId, adminName || '');
      customerId = customer.id;
      cardId = card.id;
      cardLast4 = card.last_4 || '';
      cardBrand = card.card_brand || '';
    }

    // 2. Calculate trial and billing dates
    const trialDays = skipTrial ? 0 : 14;
    const now = new Date();
    const nextBillingDate = new Date(now.getTime() + trialDays * 86400000).toISOString().split('T')[0];
    const trialEndsAt = trialDays > 0 ? new Date(now.getTime() + trialDays * 86400000).toISOString() : null;
    const currentPeriodStart = now.toISOString();

    // 3. Upsert subaccount_plans row with Square billing info
    const planPayload = {
      subaccount_id: subaccountId,
      plan_tier: tier,
      billing_period: billingPeriod,
      hipaa_addon: !!hipaaAddon,
      status: trialDays > 0 ? 'trialing' : 'active',
      square_customer_id: customerId,
      square_card_id: cardId,
      trial_ends_at: trialEndsAt,
      next_billing_date: nextBillingDate,
      current_period_start: currentPeriodStart,
      retry_count: 0,
      exempt_from_billing: false,
      discount_percent: discountPercent || 0,
      discount_note: discountNote || null,
      card_last4: cardLast4 || null,
      card_brand: cardBrand || null,
      updated_at: now.toISOString()
    };

    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_plans', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(planPayload)
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('setup-billing: DB upsert failed after card save. Customer:', customerId, 'Card:', cardId, errText);
      await logAudit({
        req, ...actor,
        action: 'agency.subaccount.setup_billing',
        targetType: 'subaccount',
        targetId: subaccountId,
        targetSubaccountId: subaccountId,
        outcome: 'failure',
        errorMessage: 'DB upsert failed after Square card save: ' + errText,
        metadata: {
          card_source: cardSource,
          square_customer_id: customerId,
          square_card_id: cardId,
          tier: tier,
          billing_period: billingPeriod
        }
      });
      return sendError(res, 500, 'Card saved in Square but billing record failed. Contact support.', errText);
    }

    // Audit log: success
    await logAudit({
      req, ...actor,
      action: 'agency.subaccount.setup_billing',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: {
        card_source: cardSource,
        square_customer_id: customerId,
        square_card_id: cardId,
        card_last4: cardLast4 || null,
        card_brand: cardBrand || null,
        tier: tier,
        billing_period: billingPeriod,
        hipaa_addon: !!hipaaAddon,
        discount_percent: discountPercent || 0,
        trial_days: trialDays,
        next_billing_date: nextBillingDate,
        starting_status: planPayload.status
      }
    });

    return res.status(200).json({
      success: true,
      customer_id: customerId,
      card_id: cardId,
      card_last4: cardLast4,
      card_brand: cardBrand,
      next_billing_date: nextBillingDate,
      trial_ends_at: trialEndsAt,
      status: planPayload.status
    });

  } catch (e) {
    console.error('setup-billing error:', e);
    await logAudit({
      req, ...actor,
      action: 'agency.subaccount.setup_billing',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: e.message,
      metadata: {
        tier: tier,
        billing_period: billingPeriod,
        had_new_card: hasNewCard,
        had_existing_card: hasExistingCard
      }
    });
    return sendError(res, 500, 'Billing setup failed', e.message);
  }
};
