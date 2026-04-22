// api/square/charge.js
// Processes a payment against a saved card on file
// All sensitive operations happen server-side

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken, cardId, customerId, amountCents, note } = req.body || {};

  if (!accessToken || !cardId || !amountCents) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch location automatically
    const locRes = await fetch('https://connect.squareup.com/v2/locations', {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Square-Version': '2025-01-23'
      }
    });
    const locData = await locRes.json();
    const locations = locData.locations || [];
    const active = locations.find(function(l) { return l.status === 'ACTIVE'; }) || locations[0];

    if (!active) {
      return res.status(400).json({ error: 'No active Square location found' });
    }

    const idempotencyKey = Date.now().toString(36) + Math.random().toString(36).slice(2);

    const body = {
      idempotency_key: idempotencyKey,
      source_id: cardId,
      amount_money: {
        amount: amountCents,
        currency: 'USD'
      },
      location_id: active.id,
      note: note || 'MySpark+ CRM charge'
    };

    if (customerId) {
      body.customer_id = customerId;
    }

    const r = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Square-Version': '2025-01-23',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = data.errors && data.errors[0] && data.errors[0].detail;
      return res.status(400).json({ error: msg || 'Payment failed', errors: data.errors || [] });
    }

    return res.status(200).json({ payment: data.payment });

  } catch (e) {
    console.error('Charge error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
