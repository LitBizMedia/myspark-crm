// lib-aws/notifications.js
//
// Single source of truth for "should this notification fire and on which
// channels". Every automated sender calls shouldSend(subaccountId, type, db)
// before invoking Mailgun or Twilio.
//
// Logic:
//   1. Look up the type in the catalog. If unknown type, fail closed
//      (returns ok:false). Prevents silent sends for typos.
//   2. Look up the override row in subaccount_notification_settings.
//      If no row, return catalog defaults.
//   3. Required-risk types: enabled flag is forced to true regardless of
//      the DB row. UI prevents the toggle, but a corrupt or manually
//      edited row cannot disable critical sends like password_reset.
//   4. Returns { ok, email_enabled, sms_enabled, timing_minutes_before,
//      template_type, reason } so the caller knows what to do.
//
// Reusable by reminders, booking-submit, billing crons, contracts,
// automations, and any future sender.

const catalog = require('./notifications-catalog');

async function shouldSend(subaccountId, typeKey, db) {
  if (!subaccountId) return { ok: false, reason: 'no_subaccount_id' };
  if (!typeKey) return { ok: false, reason: 'no_type_key' };
  if (!db || typeof db.findOne !== 'function') return { ok: false, reason: 'no_db_handle' };

  const type = catalog.getType(typeKey);
  if (!type) return { ok: false, reason: 'unknown_type', type_key: typeKey };

  // Look up per-subaccount override (may not exist; lazy seeding)
  let override = null;
  try {
    override = await db.findOne('subaccount_notification_settings', {
      subaccount_id: subaccountId,
      notification_type: typeKey
    });
  } catch (e) {
    return { ok: false, reason: 'db_error', error: e.message };
  }

  // Admin-audience types are system communications (billing, auth, domain).
  // These are locked to email-only and always-on per platform design.
  // password_reset is locked email-only today; if patient portals ship later,
  // we may add SMS support behind a feature flag.
  const isSystem = type.audience === 'admin';

  const enabled = isSystem
    ? true
    : (override && override.enabled !== null && override.enabled !== undefined ? override.enabled : true);

  const email_enabled = isSystem
    ? true
    : (override && override.email_enabled !== null && override.email_enabled !== undefined
      ? override.email_enabled
      : type.default_email);

  const sms_enabled = isSystem
    ? false
    : (override && override.sms_enabled !== null && override.sms_enabled !== undefined
      ? override.sms_enabled
      : type.default_sms);

  const timing_minutes_before = override && override.timing_minutes_before !== null && override.timing_minutes_before !== undefined
    ? override.timing_minutes_before
    : type.default_timing_minutes_before;

  const template_type = override && override.template_type
    ? override.template_type
    : type.template_type;

  if (!enabled) {
    return { ok: false, reason: 'notification_disabled', type_key: typeKey };
  }

  return {
    ok: true,
    type_key: typeKey,
    email_enabled,
    sms_enabled,
    timing_minutes_before,
    template_type,
    risk_level: type.risk_level,
    audience: type.audience,
    status: type.status
  };
}

// Convenience: get effective settings without the should-send gate.
// Used by the UI to render current state. Does not enforce required-risk
// lock (the UI handles that visually).
async function getEffectiveSettings(subaccountId, typeKey, db) {
  const type = catalog.getType(typeKey);
  if (!type) return null;

  let override = null;
  try {
    override = await db.findOne('subaccount_notification_settings', {
      subaccount_id: subaccountId,
      notification_type: typeKey
    });
  } catch (e) {
    override = null;
  }

  const isSystem = type.audience === 'admin';

  return {
    type_key: typeKey,
    label: type.label,
    description: type.description,
    category: type.category,
    audience: type.audience,
    risk_level: type.risk_level,
    status: type.status,
    channels: type.channels,
    enabled: isSystem ? true : (override ? override.enabled : true),
    email_enabled: isSystem ? true : (override ? override.email_enabled : type.default_email),
    sms_enabled: isSystem ? false : (override ? override.sms_enabled : type.default_sms),
    timing_minutes_before: override ? override.timing_minutes_before : type.default_timing_minutes_before,
    template_type: override && override.template_type ? override.template_type : type.template_type,
    has_override: !!override,
    is_system: isSystem
  };
}

module.exports = { shouldSend, getEffectiveSettings };
