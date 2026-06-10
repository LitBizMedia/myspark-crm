// lib/patient-sms.js
// Single dispatch seam for all patient-facing transactional SMS.
//
// Senders own the words. This file owns the policy. Transport (lib/twilio.js)
// owns the wire. Three layers, one job each.
//
// Every patient SMS in the app flows through sendPatientSms. It guarantees,
// in fixed order, every time:
//   1. The notification type's SMS channel is enabled (shouldSend gate).
//   2. The contact's phone is resolved from the canonical contacts accessor.
//   3. sendSms is called with purpose 'transactional' (consent enforced inside).
//   4. A uniform result shape comes back: { sent, skipped?, failed?, reason? }.
//
// Bodies are passed in ready-to-send. No templating here by design. Clinic-
// editable SMS templates, if ever built, are their own feature with their own
// UI, the same path the email templates took.

const db = require('./db');
const { shouldSend } = require('./notifications');
const { sendSms } = require('./twilio');
const contactsLib = require('./contacts');

// The compliance footer (STOP line) goes on the FIRST message of a conversation
// only. Business name is already in every body via the copy; the STOP keyword is
// handled by Twilio Advanced Opt-Out regardless. So the visible footer is a
// best-practice signal on the conversation opener, not a per-message tax.
// An existing thread (inbound or outbound) means the opener already happened.
const OPT_OUT_FOOTER = ' Reply STOP to opt out.';

async function smsConversationExists(subaccountId, contactId) {
  try {
    const r = await db.query(
      "SELECT 1 FROM conversations WHERE subaccount_id = $1 AND contact_id = $2 AND channel = 'sms' LIMIT 1",
      [subaccountId, contactId]
    );
    return r.rows.length > 0;
  } catch (e) {
    // On lookup failure, fail safe by ASSUMING first message (append footer).
    // Better to over-include the opt-out line than to omit it.
    return false;
  }
}

/**
 * Send one patient-facing transactional SMS, behind the notification gate.
 *
 * @param {Object} opts
 * @param {string} opts.subaccountId  - 'sub-<slug>'
 * @param {string} opts.subaccountSlug- '<slug>' (twilio.sendSms wants the slug)
 * @param {string} opts.typeKey       - catalog key, e.g. 'appointment_confirmation'
 * @param {string} opts.contactId     - contact to text
 * @param {string} opts.body          - ready-to-send plain text (no templating)
 * @param {string} [opts.source]      - conversation source tag (e.g. 'confirmation')
 * @param {string} [opts.phone]       - optional pre-resolved phone; skips the lookup
 * @returns {Promise<{sent:boolean, skipped?:boolean, failed?:boolean, reason?:string, sid?:string, messageId?:string, conversationId?:string}>}
 */
async function sendPatientSms(opts) {
  opts = opts || {};
  const { subaccountId, subaccountSlug, typeKey, contactId, body, source } = opts;

  if (!subaccountId)  return { sent: false, skipped: true, reason: 'no_subaccount_id' };
  if (!subaccountSlug)return { sent: false, skipped: true, reason: 'no_slug' };
  if (!typeKey)       return { sent: false, skipped: true, reason: 'no_type_key' };
  if (!contactId)     return { sent: false, skipped: true, reason: 'no_contact_id' };
  if (!body)          return { sent: false, skipped: true, reason: 'no_body' };

  // 1. Gate. Is the SMS channel on for this type in this workspace?
  let gate;
  try {
    gate = await shouldSend(subaccountId, typeKey, db);
  } catch (e) {
    return { sent: false, failed: true, reason: 'gate_error:' + e.message };
  }
  if (!gate.ok)       return { sent: false, skipped: true, reason: gate.reason || 'gate_not_ok' };
  if (!gate.sms_enabled) return { sent: false, skipped: true, reason: 'sms_channel_off' };

  // 2. Resolve phone via canonical accessor, unless caller pre-supplied it.
  let phone = opts.phone;
  if (!phone) {
    try {
      const contact = await contactsLib.getContactById(subaccountId, contactId);
      phone = contact && contact.phone;
    } catch (e) {
      return { sent: false, failed: true, reason: 'phone_lookup_error:' + e.message };
    }
  }
  if (!phone) return { sent: false, skipped: true, reason: 'no_phone_on_contact' };

  // 2b. First-message footer. Append the STOP line only when no SMS thread
  // exists yet for this contact (the conversation opener).
  let outBody = body;
  const isFirst = !(await smsConversationExists(subaccountId, contactId));
  if (isFirst) {
    outBody = body + OPT_OUT_FOOTER;
  }

  // 3. Transport. Consent + E.164 + Twilio + conversation logging live in sendSms.
  let res;
  try {
    res = await sendSms(subaccountSlug, {
      to: phone,
      body: outBody,
      contactId,
      source: source || 'notification',
      purpose: 'transactional'
    });
  } catch (e) {
    return { sent: false, failed: true, reason: 'send_error:' + e.message };
  }

  // 4. Uniform result. sendSms returns skipped_consent as { ok:false, skipped:true }.
  if (res && res.ok) {
    return { sent: true, sid: res.sid, messageId: res.messageId, conversationId: res.conversationId };
  }
  if (res && res.skipped) {
    return { sent: false, skipped: true, reason: res.code || 'consent_skip' };
  }
  return { sent: false, failed: true, reason: (res && res.error) || 'send_failed' };
}

module.exports = { sendPatientSms };
