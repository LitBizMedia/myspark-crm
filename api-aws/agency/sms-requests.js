// api/agency/sms-requests.js (Lambda version)
// GET /api/agency/sms-requests
// Returns pending registration requests + all provisioned SMS settings.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res);
  if (!auth) return;

  try {
    const pending = await db.query(`
      SELECT * FROM sms_registration_requests 
      WHERE status IN ('requested', 'in_progress') 
      ORDER BY created_at ASC
    `);
    const provisioned = await db.query(
      'SELECT * FROM sms_settings ORDER BY created_at ASC'
    );
    return res.status(200).json({
      pending: pending.rows,
      provisioned: provisioned.rows
    });
  } catch (e) {
    console.error('sms-requests error:', e.message);
    return res.status(500).json({ error: 'Failed to load SMS requests' });
  }
}

exports.handler = wrap(handler);
