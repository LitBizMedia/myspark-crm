// lib/agency-billing.js
// Card on File billing helpers for MySpark+ SaaS subscriptions.
// Uses LitBiz Square account (slug: litbiz) to charge subaccount clients.
// Never import from client-side code. For /api/* only.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./square');

const AGENCY_SLUG = 'litbiz';

const PLAN_PRICES_CENTS = {
  starter:      { monthly: 2900,  annual: 29000 },
  professional: { monthly: 7900,  annual: 79000 },
  business:     { monthly: 14900, annual: 149000 },
  enterprise:   { monthly: 34900, annual: 349000 }
};

const HIPAA_ADDON_CENTS = { monthly: 5000, annual: 50000 };

function calculateCharge(tier, billingPeriod, hipaaAddon) {
  const base = PLAN_PRICES_CENTS[tier];
  if (!base) throw new Error('Unknown tier: ' + tier);
  const baseAmount = billingPeriod === 'annual' ? base.annual : base.monthly;
  const addonAmount = hipaaAddon
    ? (billingPeriod === 'annual' ? HIPAA_ADDON_CENTS.annual : HIPAA_ADDON_CENTS.monthly)
    : 0;
  return baseAmount + addonAmount;
}

// Get LitBiz Square credentials. Throws if not found.
async function getAgencyCreds() {
  const creds = await getSquareCreds(AGENCY_SLUG);
  if (!creds || !creds.access_token) {
    throw new Error('LitBiz Square credentials not found. Ensure Square is connected for the litbiz subaccount.');
  }
  return creds;
}

// Make a Square API call using LitBiz credentials.
// Returns { json, creds } on success. Throws on error.
async function agencySquareCall(method, pathStr, body) {
  const creds = await getAgencyCreds();
  const url = 'https://' + squareHost(creds.sandbox) + pathStr;
  const opts = {
    method,
    headers: squareHeaders(creds.access_token)
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const errMsg = json && json.errors ? JSON.stringify(json.errors) : text;
    throw new Error('Square API error ' + res.status + ': ' + errMsg);
  }
  return { json, creds };
}

// Find or create a Square customer for a subaccount.
// Uses reference_id = subaccountId so we can find them later.
async function findOrCreateCustomer(opts) {
  // Search by reference_id first
  const { json: searchJson } = await agencySquareCall('POST', '/v2/customers/search', {
    query: { filter: { reference_id: { exact: opts.referenceId } } }
  });
  if (searchJson.customers && searchJson.customers.length) {
    return searchJson.customers[0];
  }
  // Not found, create
  const { json } = await agencySquareCall('POST', '/v2/customers', {
    idempotency_key: 'msp-customer-' + opts.referenceId,
    given_name: opts.givenName || '',
    family_name: opts.familyName || '',
    email_address: opts.emailAddress || '',
    reference_id: opts.referenceId
  });
  return json.customer;
}

// Save a card on file for a customer. sourceId is the nonce from Square Web Payments SDK.
// Returns the card object from Square ({ id, last_4, card_brand, ... }).
async function saveCardOnFile(customerId, sourceId, cardholderName) {
  const { json } = await agencySquareCall('POST', '/v2/cards', {
    idempotency_key: 'msp-cof-' + customerId.slice(-12) + '-' + Date.now().toString().slice(-8),
    source_id: sourceId,
    card: {
      customer_id: customerId,
      cardholder_name: cardholderName || ''
    }
  });
  return json.card;
}

// Charge a saved card. Gets creds first so location_id is available.
// Returns { success, paymentId, payment } or { success: false, error }.
async function chargeCardOnFile(customerId, cardId, amountCents, note) {
  try {
    const creds = await getAgencyCreds();
    const url = 'https://' + squareHost(creds.sandbox) + '/v2/payments';
    const body = JSON.stringify({
      idempotency_key: 'msp-charge-' + customerId + '-' + Date.now(),
      source_id: cardId,
      customer_id: customerId,
      location_id: creds.location_id,
      amount_money: { amount: amountCents, currency: 'USD' },
      note: note || 'MySpark+ Subscription',
      autocomplete: true
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: squareHeaders(creds.access_token),
      body
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      const errMsg = json && json.errors ? JSON.stringify(json.errors) : text;
      return { success: false, error: 'Square ' + res.status + ': ' + errMsg };
    }
    return { success: true, paymentId: json.payment.id, payment: json.payment };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  AGENCY_SLUG,
  PLAN_PRICES_CENTS,
  HIPAA_ADDON_CENTS,
  calculateCharge,
  getAgencyCreds,
  findOrCreateCustomer,
  saveCardOnFile,
  chargeCardOnFile
};
