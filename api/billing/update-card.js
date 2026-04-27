// api/billing/update-card.js
// Updates the card on file for an existing subaccount.
// Accepts either a new card nonce (sourceId) or an existing Square card.
// Updates subaccount_plans with the new square_customer_id and square_card_id.

const { findOrCreateCustomer, saveCardOnFile } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');

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
    subaccountId,
    adminEmail,
    adminName,
    sourceId,
    existingCustomerId,
    existingCardId
  } = req.body || {};

  if (!subaccountId) return sendError(res, 400, 'subaccountId required');

  const hasNewCard = !!sourceId;
  const hasExistingCard = !!(existingCustomerId && existingCardId);

  if (!hasNewCard && !hasExistingCard) {
    return sendError(res, 400, 'Provide either sourceId or existingCustomerId + existingCardId');
  }

  try {
    let customerId, cardId, cardLast4 = '', cardBrand = '';

    if (hasExistingCard) {
      customerId = existingCustomerId;
      cardId = existingCardId;
    } else {
      // New card: find or create customer, save card
      const nameParts = (adminName || 'Customer').split(' ');
      const customer = await findOrCreateCustomer({
        givenName: nameParts[0] || '',
        familyName: nameParts.slice(1).join(' ') || '',
        emailAddress: adminEmail || '',
        referenceId: subaccountId
      });
      const card = await saveCardOnFile(customer.id, sourceId, adminName || '');
      customerId = customer.id;
      cardId = card.id;
      cardLast4 = card.last_4 || '';
      cardBrand = card.card_brand || '';
    }

    // Update subaccount_plans
    const updateRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + subaccountId,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({
          square_customer_id: customerId,
          square_card_id: cardId,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!updateRes.ok) {
      return sendError(res, 500, 'Card saved but plan update failed: ' + await updateRes.text());
    }

    return res.status(200).json({
      success: true,
      customer_id: customerId,
      card_id: cardId,
      card_last4: cardLast4,
      card_brand: cardBrand
    });

  } catch (e) {
    console.error('update-card error:', e);
    return sendError(res, 500, 'Card update failed', e.message);
  }
};
