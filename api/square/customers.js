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
    const customersRes = await fetch(baseUrl + '/v2/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC', { headers });
    const customersData = await customersRes.json();

    if (!customersRes.ok) {
      const msg = customersData.errors && customersData.errors[0] && customersData.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to fetch customers' });
    }

    const customers = customersData.customers || [];

    // Fetch all cards at once using the new /v2/cards endpoint
    const cardsRes = await fetch(baseUrl + '/v2/cards?limit=200', { headers });
    const cardsData = await cardsRes.json();
    const allCards = cardsData.cards || [];

    // Map cards to customers by customer_id
    const cardsByCustomer = {};
    allCards.forEach(function(card) {
      if (card.customer_id) {
        if (!cardsByCustomer[card.customer_id]) cardsByCustomer[card.customer_id] = [];
        cardsByCustomer[card.customer_id].push({
          id: card.id,
          brand: card.card_brand || 'Card',
          last4: card.last_4 || '****',
          expMonth: card.exp_month,
          expYear: card.exp_year
        });
      }
    });

    const customersWithCards = customers.map(function(customer) {
      return Object.assign({}, customer, { cards: cardsByCustomer[customer.id] || [] });
    });

    return res.status(200).json({ customers: customersWithCards, total: customersWithCards.length });

  } catch (err) {
    console.error('Square customers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
EOFcat > ~/Desktop/myspark-crm/api/square/customers.js << 'EOF'
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
    const customersRes = await fetch(baseUrl + '/v2/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC', { headers });
    const customersData = await customersRes.json();

    if (!customersRes.ok) {
      const msg = customersData.errors && customersData.errors[0] && customersData.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to fetch customers' });
    }

    const customers = customersData.customers || [];

    // Fetch all cards at once using the new /v2/cards endpoint
    const cardsRes = await fetch(baseUrl + '/v2/cards?limit=200', { headers });
    const cardsData = await cardsRes.json();
    const allCards = cardsData.cards || [];

    // Map cards to customers by customer_id
    const cardsByCustomer = {};
    allCards.forEach(function(card) {
      if (card.customer_id) {
        if (!cardsByCustomer[card.customer_id]) cardsByCustomer[card.customer_id] = [];
        cardsByCustomer[card.customer_id].push({
          id: card.id,
          brand: card.card_brand || 'Card',
          last4: card.last_4 || '****',
          expMonth: card.exp_month,
          expYear: card.exp_year
        });
      }
    });

    const customersWithCards = customers.map(function(customer) {
      return Object.assign({}, customer, { cards: cardsByCustomer[customer.id] || [] });
    });

    return res.status(200).json({ customers: customersWithCards, total: customersWithCards.length });

  } catch (err) {
    console.error('Square customers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
