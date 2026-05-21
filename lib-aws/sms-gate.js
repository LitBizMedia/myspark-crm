// lib-aws/sms-gate.js
//
// Single source of truth for whether a subaccount can send SMS via Twilio.
// Used by reminders, automations, conversation-start, and any future SMS
// surface.
//
// Why a helper:
//   1. The sms_settings schema is the canonical gate. One read pattern,
//      one place to evolve when Twilio statuses or rules change.
//   2. Reusable across all SMS senders. No drift between callers.
//   3. Returns structured reason codes so callers log without leaking PHI.
//
// Allowed campaign_status values:
//   - 'live': A2P 10DLC campaign approved AND activated by carriers.
//             This is the only state where Twilio reliably sends.
//
// If Twilio's flow ever permits sending in another status, add it to
// ALLOWED_STATUSES below. That is the only line to change.

const ALLOWED_STATUSES = ['live'];

async function canSubaccountSendSms(subaccountId, db) {
  if (!subaccountId) return { ok: false, reason: 'no_subaccount_id' };
  if (!db || typeof db.findOne !== 'function') return { ok: false, reason: 'no_db_handle' };
  try {
    const row = await db.findOne('sms_settings', { subaccount_id: subaccountId });
    if (!row) return { ok: false, reason: 'no_sms_settings' };
    if (!row.twilio_number || !row.twilio_number_sid) return { ok: false, reason: 'missing_twilio_number' };
    if (!ALLOWED_STATUSES.includes(row.campaign_status)) {
      return { ok: false, reason: 'campaign_not_live', status: row.campaign_status || null };
    }
    return { ok: true, settings: row };
  } catch (e) {
    return { ok: false, reason: 'gate_error', error: e.message };
  }
}

module.exports = { canSubaccountSendSms, ALLOWED_STATUSES };
