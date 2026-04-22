module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'No access token provided' });
  const base = 'https://connect.squareup.com';
  const hdrs = { 'Authorization': 'Bearer ' + accessToken, 'Square-Version': '2025-01-23', 'Content-Type': 'application/json' };
  try {
    const cr = await fetch(base + '/v2/customers?limit=100', { headers: hdrs });
    const cd = await cr.json();
    if (!cr.ok) return res.status(400).json({ error: (cd.errors&&cd.errors[0]&&cd.errors[0].detail)||'Failed' });
    const customers = cd.customers || [];
    const kr = await fetch(base + '/v2/cards?limit=200', { headers: hdrs });
    const kd = await kr.json();
    const allCards = kd.cards || [];
    const byCustomer = {};
    allCards.forEach(function(c) { if(c.customer_id){ if(!byCustomer[c.customer_id])byCustomer[c.customer_id]=[]; byCustomer[c.customer_id].push({id:c.id,brand:c.card_brand||'Card',last4:c.last_4||'****',expMonth:c.exp_month,expYear:c.exp_year}); } });
    const out = customers.map(function(c){ return Object.assign({},c,{cards:byCustomer[c.id]||[]}); });
    return res.status(200).json({ customers: out, total: out.length });
  } catch(e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
};
