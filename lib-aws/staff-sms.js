// lib/staff-sms.js
// Dispatch seam for internal STAFF transactional SMS (work alerts to employees).
//
// Distinct from patient-sms.js. Staff are employees, not patients:
//   - NO patient consent gate (staff agreed to work notifications by using the
//     system). Calls sendSms with bypass_consent:true and no contactId.
//   - NO STOP footer (employee work alerts, not marketing).
//   - Still honors the WORKSPACE gate (canSubaccountSendSms): the clinic
//     physically cannot send SMS without 10DLC/A2P live, regardless of recipient.
//
// This sender is pure transport-with-workspace-gate. It does NOT check the
// staff member's notify_sms preference; the CALLER checks that before calling.
// Separation: the sender sends; the caller decides who wants SMS.
//
// Phone resolution: caller may pass a pre-resolved phone, else we read
// subaccount_users.phone for staffUserId.

const db = require('./db');
const { sendSms } = require('./twilio');
const { canSubaccountSendSms } = require('./sms-gate');

/**
 * Send one internal staff SMS, behind the workspace gate only.
 *
 * @param {Object} opts
 * @param {string} opts.subaccountId   - 'sub-<slug>'
 * @param {string} opts.subaccountSlug - '<slug>' (twilio.sendSms wants the slug)
 * @param {string} [opts.staffUserId]  - staff user to text (for phone lookup)
 * @param {string} [opts.phone]        - optional pre-resolved phone; skips lookup
 * @param {string} opts.body           - ready-to-send plain text
 * @param {string} [opts.typeKey]      - notification type key (for logging/source)
 * @returns {Promise<{sent:boolean, skipped?:boolean, failed?:boolean, reason?:string, sid?:string}>}
 */
async function sendStaffSms(opts) {
  opts = opts || {};
  const { subaccountId, subaccountSlug, staffUserId, body, typeKey } = opts;

  if (!subaccountId)   return { sent: false, skipped: true, reason: 'no_subaccount_id' };
  if (!subaccountSlug) return { sent: false, skipped: true, reason: 'no_slug' };
  if (!body)           return { sent: false, skipped: true, reason: 'no_body' };

  // 1. Workspace gate. Can this clinic send SMS at all (A2P live, number assigned)?
  let gate;
  try {
    gate = await canSubaccountSendSms(subaccountId, db);
  } catch (e) {
    return { sent: false, failed: true, reason: 'workspace_gate_error:' + e.message };
  }
  if (!gate.ok) return { sent: false, skipped: true, reason: 'workspace_' + (gate.reason || 'no_sms') };

  // 2. Resolve phone. Caller-supplied wins; else read subaccount_users.phone.
  let phone = opts.phone;
  if (!phone && staffUserId) {
    try {
      const u = await db.findOne('subaccount_users', { id: staffUserId, subaccount_id: subaccountId });
      phone = u && u.phone;
    } catch (e) {
      return { sent: false, failed: true, reason: 'phone_lookup_error:' + e.message };
    }
  }
  if (!phone) return { sent: false, skipped: true, reason: 'no_phone_on_staff' };

  // 3. Transport. bypass_consent + no contactId => no consent check, no
  //    conversation threading (staff alerts are not patient conversations).
  let res;
  try {
    res = await sendSms(subaccountSlug, {
      to: phone,
      body: body,
      source: typeKey || 'staff-notification',
      purpose: 'transactional',
      bypass_consent: true
    });
  } catch (e) {
    return { sent: false, failed: true, reason: 'send_error:' + e.message };
  }

  // 4. Uniform result.
  if (res && res.ok) {
    return { sent: true, sid: res.sid, messageId: res.messageId };
  }
  if (res && res.skipped) {
    return { sent: false, skipped: true, reason: res.code || 'skipped' };
  }
  return { sent: false, failed: true, reason: (res && res.error) || 'send_failed' };
}

module.exports = { sendStaffSms };
