// api/billing/list-cards.js (Lambda version)
//
// GET /api/billing/list-cards
//
// Returns Square customers with saved cards on file for the LitBiz account.
// Used by New Subaccount modal to let Patrick select an existing card.
//
// MIGRATED: No DB changes - uses agency-billing.js helpers and Square API.

const { agencySquareCall } = require('./lib/agency-billing');
const { sendError } = require('./lib/square');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;

  try {
    const { json: custJson } = await agencySquareCall('POST', '/v2/customers/search', {
      query: {},
      limit: 100
    });

    const customers = custJson.customers || [];
    const results = [];

    for (const customer of customers) {
      if (!customer.id) continue;
      try {
        const { json: cardJson } = await agencySquareCall(
          'GET',
          '/v2/cards?customer_id=' + customer.id + '&include_disabled=false'
        );
        const cards = cardJson.cards || [];
        if (cards.length) {
          results.push({
            customerId: customer.id,
            customerName: [customer.given_name, customer.family_name].filter(Boolean).join(' ') || customer.company_name || customer.email_address || customer.id,
            email: customer.email_address || '',
            referenceId: customer.reference_id || '',
            cards: cards.map(function(c) {
              return {
                cardId: c.id,
                brand: c.card_brand || '',
                last4: c.last_4 || '',
                expMonth: c.exp_month || '',
                expYear: c.exp_year || ''
              };
            })
          });
        }
      } catch (e) {
        console.warn('list-cards: could not fetch cards for customer ' + customer.id, e.message);
      }
    }

    return res.status(200).json({ customers: results });

  } catch (e) {
    console.error('list-cards error:', e);
    return sendError(res, 500, 'Could not load cards', e.message);
  }
}

exports.handler = wrap(handler);
