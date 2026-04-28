// api/square/save-card.js
// Saves a card on file for a Square customer. Credentials looked up from square_credentials by slug.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('../../lib/square');

const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  // Require valid subaccount session
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return; // 401 already sent

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();

  // Enforce slug matches the session's subaccount (prevents IDOR across tenants)

  if (slug && auth.subaccount_id !== ('sub-' + slug)) {

    return sendError(res, 403, 'Slug does not match session');

  }

  // If slug missing, derive it from the session

  const effectiveSlug = slug || auth.subaccount_id.replace(/^sub-/, '');

  const customerId = body.customerId;
  const sourceId = body.sourceId; // one-time nonce from Web Payments SDK
  const cardholderName = (body.cardholderName || '').toString().slice(0, 150);

  if (!slug) return sendError(res, 400, 'Missing slug');
  if (!customerId) return sendError(res, 400, 'Missing customerId');
  if (!sourceId) return sendError(res, 400, 'Missing sourceId');

  const creds = await getSquareCreds(slug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const idempotencyKey = slug + '-card-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  try {
    const response = await fetch('https://' + squareHost(creds.sandbox) + '/v2/cards', {
      method: 'POST',
      headers: squareHeaders(creds.access_token),
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        card: {
          customer_id: customerId,
          cardholder_name: cardholderName
        }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, response.status, msg, data.errors);
    }
    const c = data.card || {};
    return res.status(200).json({
      success: true,
      card: {
        id: c.id,
        brand: c.card_brand || 'Card',
        last4: c.last_4 || null,
        expMonth: c.exp_month || null,
        expYear: c.exp_year || null
      }
    });
  } catch (err) {
    console.error('save-card.js error:', err);
    return sendError(res, 500, err.message || 'Save card failed');
  }
};
