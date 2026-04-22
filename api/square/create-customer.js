// api/square/create-customer.js
// Creates a Square customer record for a MySpark contact
// Called when adding a card to a contact not yet in Square

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken, name, email, phone } = req.body || {};

  if (!accessToken || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const nameParts = name.trim().split(' ');
    const givenName = nameParts[0] || '';
    const familyName = nameParts.slice(1).join(' ') || '';
    const idempotencyKey = Date.now().toString(36) + Math.random().toString(36).slice(2);

    const body = {
      idempotency_key: idempotencyKey,
      given_name: givenName,
      family_name: familyName
    };

    if (email) body.email_address = email;
    if (phone) body.phone_number = phone;

    const r = await fetch('https://connect.squareup.com/v2/customers', {
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
      return res.status(400).json({ error: msg || 'Failed to create customer' });
    }

    return res.status(200).json({ customerId: data.customer.id });

  } catch (e) {
    console.error('Create customer error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
