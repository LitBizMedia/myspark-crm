// api/agency/sms-status-update.js (Lambda version)
// POST /api/agency/sms-status-update
// Super admin: update campaign_status / enabled on existing sms_settings row.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { subaccount_id, campaign_status, enabled } = req.body || {};
  if (!subaccount_id) return res.status(400).json({ error: 'subaccount_id required' });

  const sets = [];
  const params = [subaccount_id];
  let p = 2;
  if (campaign_status !== undefined) { sets.push(`campaign_status = $${p++}`); params.push(campaign_status); }
  if (enabled !== undefined) { sets.push(`enabled = $${p++}`); params.push(!!enabled); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');

  try {
    const r = await db.query(
      `UPDATE sms_settings SET ${sets.join(', ')} WHERE subaccount_id = $1 RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'sms_settings not found' });

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.sms.status_update',
      targetType: 'sms_settings',
      targetId: subaccount_id,
      targetSubaccountId: subaccount_id,
      metadata: { campaign_status, enabled }
    });

    return res.status(200).json({ settings: r.rows[0] });
  } catch (e) {
    console.error('sms-status-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update SMS status' });
  }
}

exports.handler = wrap(handler);
