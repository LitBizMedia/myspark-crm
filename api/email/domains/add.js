// api/email/domains/add.js
// Adds a sending domain to Resend for a subaccount and stores DNS records in Supabase.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, domain } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const subaccountId = 'sub-' + slug;

  try {
    const existing = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_email_domains?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&domain=eq.' + encodeURIComponent(domain) + '&select=*&limit=1',
      { headers: svcHeaders() }
    );
    if (existing.ok) {
      const rows = await existing.json();
      if (rows && rows.length) {
        return res.status(200).json({ success: true, domain: rows[0], records: rows[0].dkim_records || [] });
      }
    }
  } catch (e) {
    console.error('Domain lookup error:', e.message);
  }

  const resendRes = await fetch('https://api.resend.com/domains', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: domain })
  });

  const resendData = await resendRes.json();

  if (!resendRes.ok) {
    return res.status(500).json({ error: resendData.message || 'Failed to add domain to Resend' });
  }

  const records = resendData.records || [];

  const row = {
    subaccount_id: subaccountId,
    domain: domain,
    resend_domain_id: resendData.id,
    status: 'pending',
    dkim_records: records
  };

  try {
    const insertRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_email_domains', {
      method: 'POST',
      headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(row)
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Supabase insert error:', err);
      return res.status(200).json({ success: true, domain: row, records });
    }

    const saved = await insertRes.json();
    return res.status(200).json({ success: true, domain: saved[0] || row, records });
  } catch (e) {
    return res.status(200).json({ success: true, domain: row, records });
  }
};
