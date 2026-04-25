// api/email/domains/remove.js
// Removes a sending domain from Resend and deletes it from Supabase.

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

  const { slug, domainId } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (!domainId) return res.status(400).json({ error: 'domainId is required' });

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const subaccountId = 'sub-' + slug;

  try {
    await fetch('https://api.resend.com/domains/' + domainId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY }
    });
  } catch (e) {
    console.error('Resend delete error:', e.message);
  }

  try {
    await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_email_domains?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&resend_domain_id=eq.' + encodeURIComponent(domainId),
      { method: 'DELETE', headers: svcHeaders() }
    );
  } catch (e) {
    console.error('Supabase delete error:', e.message);
  }

  return res.status(200).json({ success: true });
};
