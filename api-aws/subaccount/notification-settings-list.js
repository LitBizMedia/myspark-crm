// GET /api/subaccount/notification-settings
//
// Returns the full notification settings catalog merged with this
// subaccount's overrides. Used by the Notifications tab UI to render
// all toggles, channels, timing, and template states.
//
// Response shape:
//   {
//     settings: [
//       {
//         type_key, label, description, category, audience,
//         risk_level, status, channels,
//         enabled, email_enabled, sms_enabled,
//         timing_minutes_before, template_type, has_override
//       },
//       ...34 entries...
//     ],
//     categories: ['Appointments', 'Booking', ...]
//   }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { getCustomerTypes, getInternalTypes, getTypesByCategory } = require('./lib/notifications-catalog');
const { getEffectiveSettings } = require('./lib/notifications');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  const subaccountId = auth.subaccount_id;

  // Build full settings list by iterating the catalog and merging overrides
  const allTypes = [...getCustomerTypes(), ...getInternalTypes()];
  const settings = [];
  for (const t of allTypes) {
    const eff = await getEffectiveSettings(subaccountId, t.key, db);
    if (eff) settings.push(eff);
  }

  // Provide category list for UI grouping
  const byCategory = getTypesByCategory();
  const categories = Object.keys(byCategory);

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.notification_settings.view',
    targetType: 'notification_settings',
    targetSubaccountId: subaccountId,
    metadata: { type_count: settings.length }
  });

  return res.status(200).json({ settings, categories });
}

exports.handler = wrap(handler);
