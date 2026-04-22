// api/square/save-card.js
// Saves a tokenized card to a Square customer record
// Token comes from Square Web Payments SDK in the browser

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken, customerId, sourceId, cardholderName } = req.body || {};

  if (!accessToken || !customerId || !sourceId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const idempotencyKey = Date.now().toString(36) + Math.random().toString(36).slice(2);

    const r = await fetch('https://connect.squareup.com/v2/cards', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Square-Version': '2025-01-23',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        card: {
          customer_id: customerId,
          cardholder_name: cardholderName || ''
        }
      })
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = data.errors && data.errors[0] && data.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to save card' });
    }

    const card = data.card;
    return res.status(200).json({
      card: {
        id: card.id,
        brand: card.card_brand || 'Card',
        last4: card.last_4 || '****',
        expMonth: card.exp_month,
        expYear: card.exp_year
      }
    });

  } catch (e) {
    console.error('Save card error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
