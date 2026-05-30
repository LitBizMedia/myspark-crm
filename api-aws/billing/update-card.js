// api/billing/update-card.js (Lambda version)
//
// POST /api/billing/update-card
//
// Updates the card on file for an existing subaccount.
//
// MIGRATED: Supabase REST → lib/db.js for plan update.

const db = require('./lib/db');
const { findOrCreateCustomer, saveCardOnFile } = require('./lib/agency-billing');
const { sendError } = require('./lib/square');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;

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

    try {
      await db.update('subaccount_plans',
        {
          square_customer_id: customerId,
          square_card_id: cardId,
          card_last4: cardLast4 || null,
          card_brand: cardBrand || null,
          updated_at: new Date().toISOString()
        },
        { subaccount_id: subaccountId }
      );
    } catch (e) {
      return sendError(res, 500, 'Card saved but plan update failed: ' + e.message);
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
}

exports.handler = wrap(handler);
