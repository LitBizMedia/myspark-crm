// api/subaccount/sms-status.js (Lambda version)
// GET /api/subaccount/sms-status
// Returns SMS settings AND registration request for this subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const settings = await db.query(
      'SELECT * FROM sms_settings WHERE subaccount_id = $1 LIMIT 1',
      [auth.subaccount_id]
    );
    const request = await db.query(
      'SELECT * FROM sms_registration_requests WHERE subaccount_id = $1 ORDER BY created_at DESC LIMIT 1',
      [auth.subaccount_id]
    );
    return res.status(200).json({
      settings: settings.rows[0] || null,
      request: request.rows[0] || null
    });
  } catch (e) {
    console.error('sms-status error:', e.message);
    return res.status(500).json({ error: 'Failed to load SMS status' });
  }
}

exports.handler = wrap(handler);
