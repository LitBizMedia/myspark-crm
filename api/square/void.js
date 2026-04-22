// /api/square/void.js
// Cancels a Square payment that has not yet been captured or completed.
// Note: Square only allows canceling PENDING payments.
// For completed payments, use the refund endpoint instead.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken, paymentId } = req.body || {};
  if (!accessToken || !paymentId) {
    return res.status(400).json({ error: 'accessToken and paymentId required' });
  }

  const env = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl = env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  try {
    // Try to cancel first (works for pending payments)
    const cancelRes = await fetch(`${baseUrl}/v2/payments/${paymentId}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      }
    });
    const cancelData = await cancelRes.json();

    if (cancelData.payment) {
      return res.status(200).json({ success: true, payment: cancelData.payment });
    }

    // If cancel fails (payment already completed), return error with context
    const squareError = cancelData.errors?.[0]?.detail || 'Could not void payment in Square.';
    return res.status(200).json({
      error: squareError + ' If already completed, use Refund instead.'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
