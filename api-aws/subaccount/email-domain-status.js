// api/subaccount/email-domain-status.js (Lambda version)
// GET /api/subaccount/email-domain-status
// Returns the email domain config for this subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const r = await db.query(
      'SELECT * FROM subaccount_email_domains WHERE subaccount_id = $1 ORDER BY created_at DESC LIMIT 1',
      [auth.subaccount_id]
    );
    return res.status(200).json({ domain: r.rows[0] || null });
  } catch (e) {
    console.error('email-domain-status error:', e.message);
    return res.status(500).json({ error: 'Failed to load domain status' });
  }
}

exports.handler = wrap(handler);
