// api/subaccount/sms-toggle.js (Lambda version)
// POST /api/subaccount/sms-toggle
// Toggle SMS enabled/disabled for this subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  // Accept either {action:'pause'|'resume'} or legacy {enabled:bool} for compat
  const body = req.body || {};
  let targetStatus;
  if (body.action === 'pause') targetStatus = 'paused';
  else if (body.action === 'resume') targetStatus = 'live';
  else if (typeof body.enabled === 'boolean') targetStatus = body.enabled ? 'live' : 'paused';
  else return res.status(400).json({ error: 'action (pause|resume) required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Load current state to validate transition
    const check = await db.query(
      'SELECT campaign_status, twilio_number FROM sms_settings WHERE subaccount_id = $1',
      [subaccountId]
    );
    if (check.rowCount === 0) {
      return res.status(404).json({ error: 'No SMS settings found for this subaccount' });
    }
    const row = check.rows[0];
    if (!row.twilio_number) {
      return res.status(400).json({ error: 'No Twilio number assigned. Contact your administrator.' });
    }
    if (row.campaign_status === 'pending') {
      return res.status(400).json({
        error: 'SMS campaign is still pending carrier approval. Pause/resume is only available once your campaign is live.',
        code: 'CAMPAIGN_NOT_LIVE',
        campaign_status: row.campaign_status
      });
    }

    // Valid transitions: live -> paused (pause), paused -> live (resume)
    if (targetStatus === 'paused' && row.campaign_status !== 'live') {
      return res.status(400).json({ error: 'Can only pause when SMS is live' });
    }
    if (targetStatus === 'live' && row.campaign_status !== 'paused') {
      return res.status(400).json({ error: 'Can only resume when SMS is paused' });
    }

    const r = await db.query(
      'UPDATE sms_settings SET campaign_status = $1, updated_at = NOW() WHERE subaccount_id = $2 RETURNING *',
      [targetStatus, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: targetStatus === 'paused' ? 'subaccount.sms.pause' : 'subaccount.sms.resume',
      targetType: 'sms_settings',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { from: row.campaign_status, to: targetStatus }
    });

    return res.status(200).json({ settings: r.rows[0] });
  } catch (e) {
    console.error('sms-toggle error:', e.message);
    return res.status(500).json({ error: 'Failed to update SMS settings' });
  }
}

exports.handler = wrap(handler);
