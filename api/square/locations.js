// api/square/locations.js
// Fetches the merchant's active Square location ID automatically

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken } = req.body || {};
  if (!accessToken) {
    return res.status(400).json({ error: 'No access token' });
  }

  try {
    const r = await fetch('https://connect.squareup.com/v2/locations', {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Square-Version': '2025-01-23'
      }
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = data.errors && data.errors[0] && data.errors[0].detail;
      return res.status(400).json({ error: msg || 'Failed to fetch locations' });
    }

    const locations = data.locations || [];
    const active = locations.find(function(l) { return l.status === 'ACTIVE'; }) || locations[0];

    if (!active) {
      return res.status(400).json({ error: 'No active location found' });
    }

    return res.status(200).json({ locationId: active.id, locationName: active.name });

  } catch (e) {
    console.error('Locations error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
