// api/square/customer-cards.js (Lambda version)
//
// POST /api/square/customer-cards
//
// Lists the cards on file for ONE Square customer, scoped to the
// requesting subaccount's own Square account. Read-only. Replaces the
// per-customer half of the deleted bulk customers sync, without the
// 30-second timeout that bulk hit at scale (one customer, one API call).
//
// Body: { slug, customerId }
// Returns: { cards: [ { id, brand, last4, expMonth, expYear } ] }

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./lib/square');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();

  if (slug && auth.subaccount_id !== ('sub-' + slug)) {
    return sendError(res, 403, 'Slug does not match session');
  }

  const effectiveSlug = slug || auth.subaccount_id.replace(/^sub-/, '');
  const customerId = (body.customerId || '').toString().trim();

  if (!effectiveSlug) return sendError(res, 400, 'Missing slug');
  if (!customerId) return sendError(res, 400, 'Missing customerId');

  const creds = await getSquareCreds(effectiveSlug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const host = squareHost(creds.sandbox);
  const headers = squareHeaders(creds.access_token);

  try {
    const url = 'https://' + host + '/v2/cards?customer_id=' + encodeURIComponent(customerId) + '&include_disabled=false';
    const r = await fetch(url, { headers: headers });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, r.status, msg, data.errors);
    }
    const cards = (data.cards || []).map(function(c) {
      return {
        id: c.id,
        brand: c.card_brand || 'Card',
        last4: c.last_4 || null,
        expMonth: c.exp_month || null,
        expYear: c.exp_year || null
      };
    });
    return res.status(200).json({ cards: cards });
  } catch (err) {
    console.error('customer-cards.js error:', err);
    return sendError(res, 500, err.message || 'Card list failed');
  }
}

exports.handler = wrap(handler);
