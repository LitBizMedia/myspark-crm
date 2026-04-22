// api/square/find-or-create-customer.js
// Searches Square for existing customer by email
// Creates new customer if not found
// Returns squareCustomerId either way

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken, name, email, phone } = req.body || {};
  if (!accessToken || !name) return res.status(400).json({ error: 'Missing required fields' });

  const base = 'https://connect.squareup.com';
  const hdrs = {
    'Authorization': 'Bearer ' + accessToken,
    'Square-Version': '2025-01-23',
    'Content-Type': 'application/json'
  };

  try {
    // Search for existing customer by email first
    if (email) {
      const searchRes = await fetch(base + '/v2/customers/search', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          query: {
            filter: {
              email_address: { exact: email }
            }
          }
        })
      });
      const searchData = await searchRes.json();
      const existing = searchData.customers && searchData.customers[0];
      if (existing) {
        return res.status(200).json({
          customerId: existing.id,
          action: 'linked'
        });
      }
    }

    // Not found - create new Square customer
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

    const createRes = await fetch(base + '/v2/customers', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body)
    });
    const createData = await createRes.json();

    if (!createRes.ok) {
      const msg = createData.errors && createData.errors[0] && createData.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to create customer' });
    }

    return res.status(200).json({
      customerId: createData.customer.id,
      action: 'created'
    });

  } catch (e) {
    console.error('Find or create customer error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
