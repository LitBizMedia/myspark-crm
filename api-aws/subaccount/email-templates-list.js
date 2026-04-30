// api/subaccount/email-templates-list.js (Lambda version)
// GET /api/subaccount/email-templates-list
// Returns all email templates for the authenticated subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const r = await db.query(
      'SELECT * FROM email_templates WHERE subaccount_id = $1 ORDER BY template_type',
      [auth.subaccount_id]
    );
    return res.status(200).json({ templates: r.rows });
  } catch (e) {
    console.error('email-templates-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load templates' });
  }
}

exports.handler = wrap(handler);
