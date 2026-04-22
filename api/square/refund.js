// /api/square/refund.js
// Issues a refund for a completed Square payment.
// Supports full or partial refunds.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken, paymentId, amountCents, reason } = req.body || {};
  if (!accessToken || !paymentId || !amountCents) {
    return res.status(400).json({ error: 'accessToken, paymentId, and amountCents required' });
  }

  const env = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl = env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  const idempotencyKey = `refund-${paymentId}-${Date.now()}`;

  try {
    const refundRes = await fetch(`${baseUrl}/v2/refunds`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        amount_money: {
          amount: amountCents,
          currency: 'USD'
        },
        reason: reason || 'Refund issued via MySpark+ CRM'
      })
    });

    const data = await refundRes.json();

    if (data.refund) {
      return res.status(200).json({ success: true, refund: data.refund });
    }

    const squareError = data.errors?.[0]?.detail || 'Refund failed in Square.';
    return res.status(200).json({ error: squareError });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
