// api/email/domains/verify.js (Lambda version - Secrets Manager)

const db = require('./lib/db');
const { getResendApiKey } = require('./lib/resend');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin'] });
  if (!auth) return;

  const { slug, domainId } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (auth.subaccount_id !== ('sub-' + slug)) {
    return res.status(403).json({ error: 'Slug does not match session' });
  }
  if (!domainId) return res.status(400).json({ error: 'domainId is required' });

  const RESEND_API_KEY = await getResendApiKey();
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const subaccountId = 'sub-' + slug;

  // Skip the POST /verify trigger - it temporarily flips status to 'pending'
  // for ~3s and causes the immediate GET below to return stale data.
  // Resend continuously monitors DNS, so just reading current status is reliable.

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
    await db.update('subaccount_email_domains',
      updateBody,
      { subaccount_id: subaccountId, resend_domain_id: domainId }
    );
  } catch (e) {
    console.error('DB update error:', e.message);
  }

  return res.status(200).json({ success: true, status, domain: domainData });
}

exports.handler = wrap(handler);
