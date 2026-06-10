// lib/staff-notify.js
// Dispatch seam for INTERNAL staff notifications (events staff need to act on).
//
// One job: given an event, write a bell record per recipient AND escalate to
// SMS for recipients who opted in (notify_sms) and have a phone, behind the
// workspace A2P gate. Senders/callers own the words; this owns who gets it and
// how; staff-sms.js owns the SMS wire; the bell read owns display.
//
// Recipient routing, two modes:
//   - Relationship: caller passes explicit recipientUserIds (the assigned
//     provider, the task assignee). The event data names the person.
//   - Role: caller passes no recipientUserIds; the resolver expands the type's
//     role mapping to all active users in those roles.
//
// Routing defaults are hardcoded below for now. When the admin role-selector UI
// is built, it writes per-subaccount overrides that this resolver reads FIRST,
// falling back to these defaults. One place to change routing, ever.
//
// Bell record is always written. SMS is per-recipient: only if that user has
// notify_sms = true AND a phone AND the workspace can send SMS.

const db = require('./db');
const { sendStaffSms } = require('./staff-sms');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// Default role routing for role-routed types. Relationship types are not here;
// they pass recipientUserIds explicitly. A type absent from this map AND with no
// explicit recipients notifies nobody (safe default).
const DEFAULT_ROLE_ROUTING = {
  contract_signed:  ['admin'],
  payment_failed:   ['admin'],
  manual_sub_due:   ['admin'],
  form_submitted:   ['admin'],
};

// Resolve which user IDs receive a role-routed type for this subaccount.
// FUTURE: read a per-subaccount override row here first; fall back to defaults.
async function resolveRoleRecipients(subaccountId, typeKey) {
  const roles = DEFAULT_ROLE_ROUTING[typeKey];
  if (!roles || !roles.length) return [];
  try {
    const r = await db.query(
      `SELECT id FROM subaccount_users
        WHERE subaccount_id = $1 AND active = true AND role = ANY($2::text[])`,
      [subaccountId, roles]
    );
    return r.rows.map(x => x.id);
  } catch (e) {
    console.error('staff-notify resolveRoleRecipients failed:', e.message);
    return [];
  }
}

/**
 * Fire an internal staff notification.
 *
 * @param {Object} opts
 * @param {string} opts.subaccountId
 * @param {string} opts.subaccountSlug
 * @param {string} opts.typeKey            - catalog/internal key
 * @param {string} opts.title              - bell title (e.g. "New booking")
 * @param {string} [opts.body]             - bell body (in-app; may be richer)
 * @param {string} [opts.smsBody]          - SMS text (HIPAA-minimal); falls back to body
 * @param {string} [opts.actorName]        - who triggered it (display only)
 * @param {string} [opts.linkType]         - e.g. 'appointment','contract'
 * @param {string} [opts.linkId]           - id the bell item links to
 * @param {string[]} [opts.recipientUserIds] - explicit recipients (relationship
 *                                            routing). If omitted, role routing.
 * @returns {Promise<{ok:boolean, bell:number, sms:number, recipients:number}>}
 */
async function notifyStaff(opts) {
  opts = opts || {};
  const { subaccountId, subaccountSlug, typeKey, title } = opts;
  if (!subaccountId || !typeKey || !title) {
    return { ok: false, bell: 0, sms: 0, recipients: 0, reason: 'missing_required' };
  }

  // Resolve recipients: explicit (relationship) or by role.
  let recipientIds = Array.isArray(opts.recipientUserIds) ? opts.recipientUserIds.filter(Boolean) : null;
  if (!recipientIds || !recipientIds.length) {
    recipientIds = await resolveRoleRecipients(subaccountId, typeKey);
  }
  // Dedupe.
  recipientIds = Array.from(new Set(recipientIds));
  if (!recipientIds.length) {
    return { ok: true, bell: 0, sms: 0, recipients: 0, reason: 'no_recipients' };
  }

  const body = opts.body || title;
  const smsBody = opts.smsBody || body;
  let bell = 0, sms = 0;

  for (const userId of recipientIds) {
    // 1. Bell record (always).
    try {
      await db.query(
        `INSERT INTO internal_notifications
           (id, subaccount_id, type_key, recipient_user_id, title, body, link_type, link_id, actor_name, is_read, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,NOW())`,
        [uid(), subaccountId, typeKey, userId, title, body,
         opts.linkType || null, opts.linkId || null, opts.actorName || null]
      );
      bell++;
    } catch (e) {
      console.error('staff-notify bell insert failed for', userId, ':', e.message);
      continue; // no SMS if the bell record didn't land
    }

    // 2. SMS escalation (only if this user opted in + has a phone).
    try {
      const u = await db.findOne('subaccount_users', { id: userId, subaccount_id: subaccountId });
      if (u && u.notify_sms && u.phone) {
        const r = await sendStaffSms({
          subaccountId,
          subaccountSlug,
          phone: u.phone,
          staffUserId: userId,
          body: smsBody,
          typeKey
        });
        if (r && r.sent) sms++;
      }
    } catch (e) {
      console.warn('staff-notify SMS escalation failed for', userId, ':', e.message);
    }
  }

  console.log('staff notify [' + typeKey + ']: ' + bell + ' bell, ' + sms + ' sms, ' + recipientIds.length + ' recipients');
  return { ok: true, bell, sms, recipients: recipientIds.length };
}

module.exports = { notifyStaff, resolveRoleRecipients, DEFAULT_ROLE_ROUTING };
