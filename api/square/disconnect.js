// api/square/disconnect.js
// Deletes Square credentials for a workspace from the secured table.
// Also clears the connection marker in subaccount_data.

const { deleteSquareCreds } = require('../../lib/square');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function clearSubaccountDataMarker(slug) {
  const subaccountId = 'sub-' + slug;
  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  };
  const getRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=data', { headers: headers });
  if (!getRes.ok) return;
  const rows = await getRes.json();
  if (!Array.isArray(rows) || !rows.length) return;
  const data = rows[0].data || {};
  data.settings = data.settings || {};
  data.settings.square = { appId: '', accessToken: '', merchantId: '', locationId: '', sandbox: true };
  await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId), {
    method: 'PATCH',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  try {
    await deleteSquareCreds(slug);
    try { await clearSubaccountDataMarker(slug); } catch (e) { console.warn('disconnect: marker clear failed:', e.message); }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('disconnect.js error:', err);
    return res.status(500).json({ error: err.message });
  }
};
