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

  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      'UPDATE sms_settings SET enabled = $1, updated_at = NOW() WHERE subaccount_id = $2 RETURNING *',
      [enabled, subaccountId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'No SMS settings found for this subaccount' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.sms.toggle',
      targetType: 'sms_settings',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { enabled }
    });

    return res.status(200).json({ settings: r.rows[0] });
  } catch (e) {
    console.error('sms-toggle error:', e.message);
    return res.status(500).json({ error: 'Failed to update SMS settings' });
  }
}

exports.handler = wrap(handler);
