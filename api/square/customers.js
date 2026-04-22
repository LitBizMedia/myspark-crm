// api/square/customers.js
// Fetches Square customers and their cards on file
// Access token passed from app, never stored server-side in this phase

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken } = req.body || {};

  if (!accessToken) {
    return res.status(400).json({ error: 'No access token provided' });
  }

  const baseUrl = 'https://connect.squareup.com';
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Square-Version': '2025-01-23',
    'Content-Type': 'application/json'
  };

  try {
    // Fetch all customers (up to 100)
    const customersRes = await fetch(baseUrl + '/v2/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC', { headers });
    const customersData = await customersRes.json();

    if (!customersRes.ok) {
      const msg = customersData.errors && customersData.errors[0] && customersData.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to fetch customers' });
    }

    const customers = customersData.customers || [];

    // Fetch cards for each customer in parallel
    const customersWithCards = await Promise.all(
      customers.map(async function(customer) {
        try {
          const cardsRes = await fetch(baseUrl + '/v2/customers/' + customer.id + '/cards', { headers });
          const cardsData = await cardsRes.json();
          return Object.assign({}, customer, { cards: cardsData.cards || [] });
        } catch (e) {
          return Object.assign({}, customer, { cards: [] });
        }
      })
    );

    return res.status(200).json({ customers: customersWithCards, total: customersWithCards.length });

  } catch (err) {
    console.error('Square customers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
