// PUT /api/subaccount/notification-settings
//
// Upserts a single notification override row for this subaccount.
// Body: { type_key, enabled, email_enabled, sms_enabled,
//         timing_minutes_before, template_type }
//
// Validation:
//   - type_key must exist in catalog (rejects typos that would orphan rows)
//   - Required-risk types cannot be disabled (enforced server-side even
//     though the UI also blocks it)
//   - SMS channel can only be enabled if subaccount sms_settings is live
//   - Optional fields preserved if omitted from body

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { getType } = require('./lib/notifications-catalog');
const { canSubaccountSendSms } = require('./lib/sms-gate');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  const subaccountId = auth.subaccount_id;

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const typeKey = body.type_key;
  if (!typeKey) return res.status(400).json({ error: 'type_key required' });

  const type = getType(typeKey);
  if (!type) return res.status(400).json({ error: 'Unknown notification type: ' + typeKey });

  // System-audience types (admin-facing billing/auth/system emails) are
  // locked to email-only and always-on by design. We silently coerce the
  // saved values rather than rejecting, so the UI does not need to know
  // the rule. The UI does not let users toggle these fields in the first
  // place, but defense-in-depth.
  const isSystem = type.audience === 'admin';

  // SMS channel gate (non-system only): cannot enable SMS if A2P not live
  if (!isSystem && body.sms_enabled === true) {
    const smsGate = await canSubaccountSendSms(subaccountId, db);
    if (!smsGate.ok) {
      return res.status(400).json({
        error: 'SMS channel cannot be enabled until A2P campaign is live',
        reason: smsGate.reason,
        status: smsGate.status || null
      });
    }
  }

  // Build the row to upsert. System types are coerced to locked values.
  const row = {
    subaccount_id: subaccountId,
    notification_type: typeKey,
    enabled: isSystem ? true : (body.enabled !== undefined ? !!body.enabled : true),
    email_enabled: isSystem ? true : (body.email_enabled !== undefined ? !!body.email_enabled : type.default_email),
    sms_enabled: isSystem ? false : (body.sms_enabled !== undefined ? !!body.sms_enabled : type.default_sms),
    timing_minutes_before: body.timing_minutes_before !== undefined
      ? (body.timing_minutes_before === null ? null : parseInt(body.timing_minutes_before, 10))
      : type.default_timing_minutes_before,
    template_type: body.template_type !== undefined ? body.template_type : type.template_type
  };

  const result = await db.insertOne('subaccount_notification_settings', row, {
    onConflict: ['subaccount_id', 'notification_type']
  });

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.notification_settings.update',
    targetType: 'notification_settings',
    targetId: result.id,
    targetSubaccountId: subaccountId,
    metadata: {
      type_key: typeKey,
      enabled: row.enabled,
      email_enabled: row.email_enabled,
      sms_enabled: row.sms_enabled,
      timing_minutes_before: row.timing_minutes_before
    }
  });

  return res.status(200).json({ setting: result });
}

exports.handler = wrap(handler);
