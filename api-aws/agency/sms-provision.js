// api/agency/sms-provision.js (Lambda version)
// POST /api/agency/sms-provision
// Super admin: creates SMS settings entry and updates registration status.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { subaccount_id, twilio_number, twilio_number_sid, campaign_status, request_id, notes } = req.body || {};
  if (!subaccount_id) return res.status(400).json({ error: 'subaccount_id required' });
  if (!twilio_number) return res.status(400).json({ error: 'twilio_number required' });
  if (!twilio_number_sid) return res.status(400).json({ error: 'twilio_number_sid required' });

  // Default provision state is 'pending' (awaiting Twilio approval).
  // Agency can pass campaign_status explicitly to override (rare).
  const finalStatus = campaign_status || 'pending';
  if (!['pending', 'live', 'paused'].includes(finalStatus)) {
    return res.status(400).json({ error: 'campaign_status must be one of: pending, live, paused' });
  }

  try {
    // Upsert sms_settings (no enabled column anymore)
    await db.query(`
      INSERT INTO sms_settings (subaccount_id, twilio_number, twilio_number_sid, campaign_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (subaccount_id) DO UPDATE SET
        twilio_number = EXCLUDED.twilio_number,
        twilio_number_sid = EXCLUDED.twilio_number_sid,
        campaign_status = EXCLUDED.campaign_status,
        updated_at = NOW()
    `, [subaccount_id, twilio_number, twilio_number_sid, finalStatus]);

    // Ensure inbound is fully wired on the Twilio side: every Messaging Service
    // defers to the number webhook, and every number's SmsUrl points at us.
    // Account-wide and idempotent. Soft fail: a Twilio hiccup must not block
    // onboarding. The daily sms-inbound-sync cron is the backstop.
    let webhookResult = { ok: false, errors: ['not attempted'] };
    try {
      const { syncTwilioInboundConfig } = require('./lib/twilio');
      webhookResult = await syncTwilioInboundConfig();
      if (!webhookResult.ok) {
        console.error('sms-provision: inbound sync incomplete for', subaccount_id, '-', (webhookResult.errors || []).join('; '));
      }
    } catch (e) {
      webhookResult = { ok: false, errors: [e.message] };
      console.error('sms-provision: inbound sync threw for', subaccount_id, '-', e.message);
    }

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
      actorType: 'agency_admin',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.sms.provision',
      targetType: 'sms_settings',
      targetId: subaccount_id,
      targetSubaccountId: subaccount_id,
      metadata: { twilio_number, campaign_status, request_id, inbound_sync_ok: webhookResult.ok, inbound_sync_errors: webhookResult.ok ? null : (webhookResult.errors || []) }
    });

    return res.status(200).json({ success: true, inbound_sync_ok: webhookResult.ok });
  } catch (e) {
    console.error('sms-provision error:', e.message);
    return res.status(500).json({ error: 'Failed to provision SMS' });
  }
}

exports.handler = wrap(handler);
