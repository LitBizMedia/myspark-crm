// api/square/charge.js
// Charges a card (via Web Payments nonce OR saved card id) for the given workspace.
// Credentials are looked up from square_credentials by slug. Client-supplied tokens are ignored.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('../../lib/square');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  const sourceId = body.sourceId;              // Either a one-time card nonce OR a card-on-file id
  const cardId = body.cardId;                  // Saved card id (alternative to sourceId)
  const customerId = body.customerId || null;  // Required when charging a saved card
  const amountCents = parseInt(body.amountCents, 10);
  const note = (body.note || 'MySpark+ payment').toString().slice(0, 500);

  if (!slug) return sendError(res, 400, 'Missing slug');
  if (!sourceId && !cardId) return sendError(res, 400, 'Missing sourceId or cardId');
  if (cardId && !customerId) return sendError(res, 400, 'customerId is required when charging a saved card');
  if (!amountCents || amountCents < 1) return sendError(res, 400, 'Invalid amountCents');

  const creds = await getSquareCreds(slug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const idempotencyKey = slug + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const payload = {
    source_id: cardId || sourceId,
    idempotency_key: idempotencyKey,
    amount_money: { amount: amountCents, currency: 'USD' },
    note: note
  };
  if (customerId) payload.customer_id = customerId;
  if (creds.location_id) payload.location_id = creds.location_id;

  try {
    const response = await fetch('https://' + squareHost(creds.sandbox) + '/v2/payments', {
      method: 'POST',
      headers: squareHeaders(creds.access_token),
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, response.status, msg, data.errors);
    }
    return res.status(200).json({
      success: true,
      payment: data.payment ? { id: data.payment.id, status: data.payment.status, receiptUrl: data.payment.receipt_url } : null
    });
  } catch (err) {
    console.error('charge.js error:', err);
    return sendError(res, 500, err.message || 'Charge failed');
  }
};
