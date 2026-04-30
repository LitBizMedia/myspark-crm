// api/email/domains/add.js (Lambda version - Secrets Manager)
//
// POST /api/email/domains/add
//
// CREDENTIALS: RESEND_API_KEY via lib/resend.js (Secrets Manager backed).

const db = require('./lib/db');
const { getResendApiKey } = require('./lib/resend');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin'] });
  if (!auth) return;

  const { slug, domain } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (auth.subaccount_id !== ('sub-' + slug)) {
    return res.status(403).json({ error: 'Slug does not match session' });
  }
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const RESEND_API_KEY = await getResendApiKey();
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const subaccountId = 'sub-' + slug;

  try {
    const existing = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId, domain: domain }
    );
    if (existing) {
      return res.status(200).json({ success: true, domain: existing, records: existing.dkim_records || [] });
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
    const saved = await db.insertOne('subaccount_email_domains', row);
    return res.status(200).json({ success: true, domain: saved || row, records });
  } catch (e) {
    console.error('DB insert error:', e.message);
    return res.status(200).json({ success: true, domain: row, records });
  }
}

exports.handler = wrap(handler);
