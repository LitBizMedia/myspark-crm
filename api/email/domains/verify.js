// api/email/domains/verify.js
// Checks Resend for domain verification status and updates Supabase.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const { requireSubaccountAuth } = require('../../../lib/require-subaccount-auth');
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

  // Require valid subaccount session (admin only)
  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin'] });
  if (!auth) return; // 401 already sent

  const { slug, domainId } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug is required' });


  // Enforce slug matches the session's subaccount (prevents IDOR across tenants)

  if (auth.subaccount_id !== ('sub-' + slug)) {

    return res.status(403).json({ error: 'Slug does not match session' });

  }
  if (!domainId) return res.status(400).json({ error: 'domainId is required' });

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const subaccountId = 'sub-' + slug;

  try {
    await fetch('https://api.resend.com/domains/' + domainId + '/verify', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY }
    });
  } catch (e) {
    console.error('Resend verify trigger error:', e.message);
  }

  const domainRes = await fetch('https://api.resend.com/domains/' + domainId, {
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY }
  });

  if (!domainRes.ok) {
    return res.status(500).json({ error: 'Failed to check domain status from Resend' });
  }

  const domainData = await domainRes.json();
  const status = domainData.status === 'verified' ? 'verified' : 'pending';

  const updateBody = { status };
  if (status === 'verified') updateBody.verified_at = new Date().toISOString();

  try {
    await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_email_domains?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&resend_domain_id=eq.' + encodeURIComponent(domainId),
      {
        method: 'PATCH',
        headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify(updateBody)
      }
    );
  } catch (e) {
    console.error('Supabase update error:', e.message);
  }

  return res.status(200).json({ success: true, status, domain: domainData });
};
