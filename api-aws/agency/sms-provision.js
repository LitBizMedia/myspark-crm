// api/agency/sms-provision.js (Lambda version)
// POST /api/agency/sms-provision
// Super admin: creates SMS settings entry and updates registration status.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { subaccount_id, twilio_number, twilio_number_sid, campaign_status, request_id, notes } = req.body || {};
  if (!subaccount_id) return res.status(400).json({ error: 'subaccount_id required' });
  if (!twilio_number) return res.status(400).json({ error: 'twilio_number required' });
  if (!twilio_number_sid) return res.status(400).json({ error: 'twilio_number_sid required' });
  if (!campaign_status) return res.status(400).json({ error: 'campaign_status required' });

  try {
    // Upsert sms_settings
    await db.query(`
      INSERT INTO sms_settings (subaccount_id, twilio_number, twilio_number_sid, campaign_status, enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (subaccount_id) DO UPDATE SET
        twilio_number = EXCLUDED.twilio_number,
        twilio_number_sid = EXCLUDED.twilio_number_sid,
        campaign_status = EXCLUDED.campaign_status,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
    `, [subaccount_id, twilio_number, twilio_number_sid, campaign_status, campaign_status === 'approved']);

    // Update registration request status
    if (request_id) {
      await db.query(`
        UPDATE sms_registration_requests 
        SET status = 'provisioned', notes = $2, updated_at = NOW()
        WHERE id = $1
      `, [request_id, notes || null]);
    }

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.sms.provision',
      targetType: 'sms_settings',
      targetId: subaccount_id,
      targetSubaccountId: subaccount_id,
      metadata: { twilio_number, campaign_status, request_id }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('sms-provision error:', e.message);
    return res.status(500).json({ error: 'Failed to provision SMS' });
  }
}

exports.handler = wrap(handler);
