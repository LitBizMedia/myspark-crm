// api/square/refund.js
// Refunds a captured payment, full or partial.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('../../lib/square');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  const paymentId = body.paymentId;
  const amountCents = parseInt(body.amountCents, 10);
  const reason = (body.reason || '').toString().slice(0, 500);

  if (!slug) return sendError(res, 400, 'Missing slug');
  if (!paymentId) return sendError(res, 400, 'Missing paymentId');
  if (!amountCents || amountCents < 1) return sendError(res, 400, 'Invalid amountCents');

  const creds = await getSquareCreds(slug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const idempotencyKey = slug + '-refund-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  try {
    const response = await fetch('https://' + squareHost(creds.sandbox) + '/v2/refunds', {
      method: 'POST',
      headers: squareHeaders(creds.access_token),
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        amount_money: { amount: amountCents, currency: 'USD' },
        reason: reason || undefined
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, response.status, msg, data.errors);
    }
    return res.status(200).json({ success: true, refund: data.refund ? { id: data.refund.id, status: data.refund.status } : null });
  } catch (err) {
    console.error('refund.js error:', err);
    return sendError(res, 500, err.message || 'Refund failed');
  }
};
