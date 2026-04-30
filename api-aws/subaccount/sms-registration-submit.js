// api/subaccount/sms-registration-submit.js (Lambda version)
// POST /api/subaccount/sms-registration-submit
// Submits an SMS registration request for the authenticated subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const r = req.body || {};
  if (!r.legal_business_name) return res.status(400).json({ error: 'legal_business_name required' });
  if (!r.ein) return res.status(400).json({ error: 'ein required' });
  if (!r.contact_name) return res.status(400).json({ error: 'contact_name required' });
  if (!r.contact_phone) return res.status(400).json({ error: 'contact_phone required' });

  const subaccountId = auth.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');
  const subaccountName = r.subaccount_name || slug;

  try {
    const insert = await db.query(`
      INSERT INTO sms_registration_requests
        (subaccount_id, subaccount_name, legal_business_name, ein, website,
         contact_name, contact_phone, contact_email, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', NOW(), NOW())
      RETURNING *
    `, [
      subaccountId, subaccountName, r.legal_business_name, r.ein,
      r.website || null, r.contact_name, r.contact_phone, r.contact_email || null
    ]);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.sms_registration.submit',
      targetType: 'sms_registration',
      targetId: insert.rows[0].id,
      targetSubaccountId: subaccountId,
      metadata: { legal_business_name: r.legal_business_name }
    });

    return res.status(200).json({ request: insert.rows[0] });
  } catch (e) {
    console.error('sms-registration-submit error:', e.message);
    return res.status(500).json({ error: 'Failed to submit registration' });
  }
}

exports.handler = wrap(handler);
