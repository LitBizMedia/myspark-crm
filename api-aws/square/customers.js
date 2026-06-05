// api/square/customers.js (Lambda version)
//
// POST /api/square/customers
//
// Lists Square customers and their cards on file.
//
// MIGRATED: No DB changes - delegates to lib/square.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./lib/square');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) return sendError(res, 401, 'Not authenticated');

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  if (!slug) return sendError(res, 400, 'Missing slug');

  if (session.user_type === 'subaccount' && session.subaccount_id !== ('sub-' + slug)) {
    return sendError(res, 403, 'Slug does not match session');
  }

  const creds = await getSquareCreds(slug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const host = squareHost(creds.sandbox);
  const headers = squareHeaders(creds.access_token);

  try {
    const customers = [];
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const url = 'https://' + host + '/v2/customers?sort_field=DEFAULT&sort_order=ASC&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const listRes = await fetch(url, { headers: headers });
      const listData = await listRes.json();
      if (!listRes.ok) {
        const msg = (listData.errors && listData.errors[0] && listData.errors[0].detail) || 'Square API error';
        return sendError(res, listRes.status, msg, listData.errors);
      }
      if (Array.isArray(listData.customers)) customers.push(...listData.customers);
      cursor = listData.cursor || null;
      if (!cursor) break;
    }

    const enriched = [];
    for (const c of customers) {
      let cards = [];
      try {
        const cardsRes = await fetch('https://' + host + '/v2/cards?customer_id=' + encodeURIComponent(c.id), { headers: headers });
        const cardsData = await cardsRes.json();
        if (cardsRes.ok && Array.isArray(cardsData.cards)) cards = cardsData.cards;
      } catch (e) {
        console.warn('Failed to fetch cards for customer', c.id, e.message);
      }
      enriched.push({
        id: c.id,
        given_name: c.given_name || '',
        family_name: c.family_name || '',
        email_address: c.email_address || '',
        phone_number: c.phone_number || '',
        cards: cards.map(k => ({
          id: k.id,
          brand: k.card_brand,
          last4: k.last_4,
          exp_month: k.exp_month,
          exp_year: k.exp_year
        }))
      });
    }

    return res.status(200).json({ customers: enriched });
  } catch (err) {
    console.error('customers.js error:', err);
    return sendError(res, 500, err.message || 'Customer list failed');
  }
}

exports.handler = wrap(handler);
