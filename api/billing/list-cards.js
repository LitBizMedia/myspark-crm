// api/billing/list-cards.js
// Returns Square customers with saved cards on file for the LitBiz account.
// Used by the New Subaccount modal to let Patrick select an existing card.

const { getAgencyCreds, agencySquareCall } = require('../../lib/agency-billing');
const { sendError } = require('../../lib/square');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  try {
    // Fetch all customers for LitBiz Square account
    const { json: custJson } = await agencySquareCall('POST', '/v2/customers/search', {
      query: {},
      limit: 100
    });

    const customers = custJson.customers || [];
    const results = [];

    for (const customer of customers) {
      if (!customer.id) continue;
      // Fetch cards for this customer
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
        // Skip customers where card fetch fails
        console.warn('list-cards: could not fetch cards for customer ' + customer.id, e.message);
      }
    }

    return res.status(200).json({ customers: results });

  } catch (e) {
    console.error('list-cards error:', e);
    return sendError(res, 500, 'Could not load cards', e.message);
  }
};
