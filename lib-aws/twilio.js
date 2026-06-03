// lib/twilio.js
// Shared SMS sending helper using Twilio.
//
// Reads credentials from AWS Secrets Manager (myspark/integrations/twilio).
// Falls back to env vars for local development.
// Writes SMS messages to conversations + conversation_messages (NOT sms_log).
// Sets Twilio statusCallback so we can track delivery state.

const crypto = require('crypto');
const db = require('./db');
const { canSubaccountSendSms } = require('./sms-gate');
const secrets = require('./secrets');

// Match the email-conversation token pattern from lib/ses.js so any future
// cross-channel code sees a single token format.
const replyToken = () => crypto.randomBytes(16).toString('hex');

const TWILIO_SECRET_NAME = 'myspark/integrations/twilio';

// Resolve Twilio credentials. Cached after first lookup by lib/secrets.
async function getTwilioCreds() {
  const sid = await secrets.getKey(TWILIO_SECRET_NAME, 'TWILIO_ACCOUNT_SID');
  const keySid = await secrets.getKey(TWILIO_SECRET_NAME, 'TWILIO_API_KEY_SID');
  const keySecret = await secrets.getKey(TWILIO_SECRET_NAME, 'TWILIO_API_KEY_SECRET');
  return { sid, keySid, keySecret };
}

function basicAuthHeader(keySid, keySecret) {
  return 'Basic ' + Buffer.from(keySid + ':' + keySecret).toString('base64');
}

// Where Twilio should POST delivery status callbacks for outbound messages
function statusCallbackUrl() {
  // Custom domain is the public API host. Falls back to env for dev.
  const apiHost = process.env.API_PUBLIC_HOST || 'api.mysparkplus.app';
  return 'https://' + apiHost + '/api/sms/status';
}

// Where Twilio routes incoming SMS (set once per number on Twilio side)
function inboundWebhookUrl() {
  const apiHost = process.env.API_PUBLIC_HOST || 'api.mysparkplus.app';
  return 'https://' + apiHost + '/api/sms/inbound';
}

// Set a phone number's inbound SMS webhook on the Twilio side.
// Points Twilio at /api/sms/inbound so patient replies reach us.
// Idempotent: setting the same URL twice is a harmless no-op.
// Returns { ok, smsUrl?, error?, code? }.
async function setInboundWebhook(pnSid) {
  if (!pnSid) return { ok: false, error: 'pnSid is required' };

  let creds;
  try {
    creds = await getTwilioCreds();
  } catch (e) {
    return { ok: false, error: 'Twilio credentials unavailable: ' + e.message };
  }
  if (!creds.sid || !creds.keySid || !creds.keySecret) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }

  const targetUrl = inboundWebhookUrl();
  const params = new URLSearchParams({
    SmsUrl: targetUrl,
    SmsMethod: 'POST'
  });

  try {
    const res = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + creds.sid + '/IncomingPhoneNumbers/' + pnSid + '.json',
      {
        method: 'POST',
        headers: {
          'Authorization': basicAuthHeader(creds.keySid, creds.keySecret),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.message || ('Twilio error ' + res.status), code: data.code };
    }
    return { ok: true, smsUrl: data.sms_url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Account-wide inbound sync. Two invariants, both required for inbound to work:
//   1. Every Messaging Service has useInboundWebhookOnNumber = true (so the
//      service defers to the number's webhook instead of swallowing inbound).
//   2. Every number's SmsUrl points at /api/sms/inbound.
// Idempotent. Run at provision time and by the daily cron.
// PageSize 1000 covers the account well past current scale; beyond 1000
// services or numbers, add next-page following (forward-path item).
// Returns { ok, services:[...], numbers:[...], errors:[...] }.
async function syncTwilioInboundConfig() {
  let creds;
  try {
    creds = await getTwilioCreds();
  } catch (e) {
    return { ok: false, errors: ['Twilio credentials unavailable: ' + e.message] };
  }
  if (!creds.sid || !creds.keySid || !creds.keySecret) {
    return { ok: false, errors: ['Twilio credentials not configured'] };
  }
  const auth = basicAuthHeader(creds.keySid, creds.keySecret);
  const results = { ok: true, services: [], numbers: [], errors: [] };

  // 1. Messaging Services: ensure useInboundWebhookOnNumber = true
  try {
    const svcRes = await fetch('https://messaging.twilio.com/v1/Services?PageSize=1000',
      { headers: { Authorization: auth } });
    const svcData = await svcRes.json();
    if (!svcRes.ok) {
      results.ok = false;
      results.errors.push('list services: ' + (svcData.message || svcRes.status));
    } else {
      for (const s of (svcData.services || [])) {
        if (s.use_inbound_webhook_on_number === true) {
          results.services.push({ sid: s.sid, action: 'already_ok' });
          continue;
        }
        const params = new URLSearchParams({ UseInboundWebhookOnNumber: 'true' });
        const r = await fetch('https://messaging.twilio.com/v1/Services/' + s.sid, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const d = await r.json();
        if (r.ok) {
          results.services.push({ sid: s.sid, action: 'set_true' });
        } else {
          results.ok = false;
          results.services.push({ sid: s.sid, action: 'failed', error: d.message });
          results.errors.push('service ' + s.sid + ': ' + (d.message || r.status));
        }
      }
    }
  } catch (e) {
    results.ok = false;
    results.errors.push('services step: ' + e.message);
  }

  // 2. Numbers: ensure SmsUrl points at the inbound endpoint
  try {
    const numRes = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + creds.sid + '/IncomingPhoneNumbers.json?PageSize=1000',
      { headers: { Authorization: auth } });
    const numData = await numRes.json();
    if (!numRes.ok) {
      results.ok = false;
      results.errors.push('list numbers: ' + (numData.message || numRes.status));
    } else {
      const targetUrl = inboundWebhookUrl();
      for (const n of (numData.incoming_phone_numbers || [])) {
        if (n.sms_url === targetUrl && n.sms_method === 'POST') {
          results.numbers.push({ sid: n.sid, action: 'already_ok' });
          continue;
        }
        const setRes = await setInboundWebhook(n.sid);
        if (setRes.ok) {
          results.numbers.push({ sid: n.sid, action: 'set' });
        } else {
          results.ok = false;
          results.numbers.push({ sid: n.sid, action: 'failed', error: setRes.error });
          results.errors.push('number ' + n.sid + ': ' + setRes.error);
        }
      }
    }
  } catch (e) {
    results.ok = false;
    results.errors.push('numbers step: ' + e.message);
  }

  return results;
}

async function getSmsSettings(subaccountId) {
  try {
    return await db.findOne('sms_settings', { subaccount_id: subaccountId });
  } catch (e) {
    console.error('getSmsSettings error:', e.message);
    return null;
  }
}

function applyVars(str, vars) {
  if (!str || !vars) return str;
  return Object.keys(vars).reduce(function(result, key) {
    return result.split('{{' + key + '}}').join(vars[key] != null ? String(vars[key]) : '');
  }, str);
}

// Normalize a phone number to E.164. Delegates to canonical lib-aws/phone.js.
const { normalizePhone } = require('./phone');

// Find or create a conversation for this contact + SMS channel.
// Returns the conversation row.
async function findOrCreateSmsConversation(subaccountId, contactId, phoneNumber) {
  // Look for existing SMS conversation with this contact
  const existing = await db.query(
    `SELECT * FROM conversations
     WHERE subaccount_id = $1 AND contact_id = $2 AND channel = 'sms'
     ORDER BY last_message_at DESC NULLS LAST
     LIMIT 1`,
    [subaccountId, contactId]
  );
  if (existing.rows.length) return existing.rows[0];

  // Create new SMS conversation
  const convId = 'conv_' + Math.random().toString(36).slice(2, 14);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO conversations
       (id, subaccount_id, contact_id, channel, status, unread_count, reply_token, created_at, updated_at)
     VALUES ($1, $2, $3, 'sms', 'open', 0, $4, $5, $5)`,
    [convId, subaccountId, contactId, replyToken(), now]
  );
  const fresh = await db.query(
    `SELECT * FROM conversations WHERE id = $1`,
    [convId]
  );
  return fresh.rows[0];
}

// Write an outbound SMS message to conversation_messages.
// Returns the message id.
async function logOutboundSms(opts) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2, 18);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO conversation_messages
       (id, conversation_id, subaccount_id, direction, channel, source,
        from_address, to_address, body_text, external_id,
        status, error, sent_by_user_id, sent_at, created_at)
     VALUES ($1, $2, $3, 'outbound', 'sms', $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      msgId,
      opts.conversationId,
      opts.subaccountId,
      opts.source || 'manual',
      opts.from,
      opts.to,
      opts.body,
      opts.twilioSid || null,
      opts.status || 'queued',
      opts.error || null,
      opts.sentByUserId || null,
      now
    ]
  );
  return msgId;
}

// Update conversation aggregates after a new outbound message
async function bumpConversationAfterOutbound(conversationId, bodyText) {
  const now = new Date().toISOString();
  const preview = (bodyText || '').slice(0, 140);
  await db.query(
    `UPDATE conversations
     SET last_message_at = $1,
         last_manual_message_at = $1,
         last_message_preview = $2,
         last_message_direction = 'outbound',
         status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
         updated_at = $1
     WHERE id = $3`,
    [now, preview, conversationId]
  );
}

/**
 * Send an SMS via Twilio. The message is recorded in conversation_messages.
 *
 * @param {string} slug - subaccount slug
 * @param {Object} opts
 * @param {string} opts.to - destination phone (will be normalized to E.164)
 * @param {string} opts.body - message body
 * @param {string} [opts.contactId] - the contact this is being sent to (required for conversation grouping)
 * @param {string} [opts.source] - 'manual' | 'reminder' | 'confirmation' (default 'manual')
 * @param {string} [opts.templateType] - legacy parameter, kept for backward compat
 * @param {Object} [opts.vars] - template variable substitutions
 * @param {string} [opts.sentByUserId] - user who triggered the send
 * @returns {Promise<{ok, sid?, messageId?, conversationId?, error?}>}
 */
async function sendSms(slug, opts) {
  const subaccountId = 'sub-' + slug;

  if (!opts || !opts.to) return { ok: false, error: 'to is required' };

  const toNormalized = normalizePhone(opts.to);
  if (!toNormalized) return { ok: false, error: 'Invalid destination phone number' };

  // Canonical SMS gate: checks sms_settings row exists, twilio_number is set,
  // and campaign_status is in ALLOWED_STATUSES (currently ['live']).
  // Returns structured reason codes; we map them to human-readable errors here.
  const gate = await canSubaccountSendSms(subaccountId, db);
  if (!gate.ok) {
    const errorMap = {
      no_sms_settings: 'SMS not configured for this workspace',
      missing_twilio_number: 'No Twilio number assigned to this workspace',
      campaign_not_live:
        gate.status === 'pending' ? 'SMS campaign is pending carrier approval' :
        gate.status === 'paused'  ? 'SMS is paused for this workspace' :
                                    'SMS is not yet active for this workspace',
      no_subaccount_id: 'Subaccount ID required',
      gate_error: 'SMS gate check failed: ' + (gate.error || 'unknown')
    };
    return { ok: false, error: errorMap[gate.reason] || ('SMS unavailable: ' + gate.reason) };
  }
  const settings = gate.settings;

  const fromNumber = settings.twilio_number;
  const body = opts.vars ? applyVars(opts.body, opts.vars) : opts.body;
  if (!body) return { ok: false, error: 'body is required' };

  // Load Twilio credentials
  let creds;
  try {
    creds = await getTwilioCreds();
  } catch (e) {
    return { ok: false, error: 'Twilio credentials unavailable: ' + e.message };
  }
  if (!creds.sid || !creds.keySid || !creds.keySecret) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }

  // SMS requires a contact to thread into a conversation. If the caller didn't
  // give us one, we still send but skip conversation logging.
  let conversation = null;
  if (opts.contactId) {
    try {
      conversation = await findOrCreateSmsConversation(subaccountId, opts.contactId, toNormalized);
    } catch (e) {
      console.error('Conversation lookup/create failed:', e.message);
      // Continue with send; just won't be threaded
    }
  }

  // Consent gate. Enforces TCPA-compliant opt-in before any send.
  // Skip ONLY if caller explicitly bypasses (used for SMS reply-to-inbound
  // where consent is implicit, since the contact initiated the conversation).
  if (!opts.bypass_consent) {
    let purpose = opts.purpose;
    if (!purpose) {
      console.warn('lib/twilio.js: opts.purpose missing; defaulting to "transactional". Caller should declare purpose explicitly.');
      purpose = 'transactional';
    }
    if (purpose !== 'transactional' && purpose !== 'marketing') {
      return { ok: false, error: 'Invalid purpose: ' + purpose };
    }
    if (opts.contactId) {
      try {
        const db = require('./db');
const { canSubaccountSendSms } = require('./sms-gate');
        const consentRow = await db.query(
          'SELECT sms_consent_transactional, sms_consent_marketing FROM contacts WHERE id = $1 AND subaccount_id = $2',
          [opts.contactId, subaccountId]
        );
        const consent = consentRow.rows[0] || {};
        const hasConsent = (purpose === 'transactional')
          ? !!consent.sms_consent_transactional
          : !!consent.sms_consent_marketing;
        if (!hasConsent) {
          return { ok: false, skipped: true, code: 'skipped_consent', error: 'Contact has not consented to ' + purpose + ' SMS' };
        }
      } catch (e) {
        console.error('SMS consent lookup failed:', e.message);
        return { ok: false, error: 'Consent verification failed' };
      }
    }
  }

  // Twilio Message Create call
  const params = new URLSearchParams({
    To: toNormalized,
    From: fromNumber,
    Body: body,
    StatusCallback: statusCallbackUrl()
  });

  try {
    const res = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + creds.sid + '/Messages.json',
      {
        method: 'POST',
        headers: {
          'Authorization': basicAuthHeader(creds.keySid, creds.keySecret),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    const data = await res.json();

    if (!res.ok) {
      // Twilio rejected. Log the failure if we have a conversation.
      if (conversation) {
        await logOutboundSms({
          conversationId: conversation.id,
          subaccountId,
          from: fromNumber,
          to: toNormalized,
          body,
          source: opts.source,
          status: 'failed',
          error: data.message || ('Twilio error ' + res.status),
          sentByUserId: opts.sentByUserId
        });
      }
      return { ok: false, error: data.message || 'Send failed', code: data.code };
    }

    // Twilio accepted. Log queued message; status callback will update it later.
    let messageId = null;
    if (conversation) {
      messageId = await logOutboundSms({
        conversationId: conversation.id,
        subaccountId,
        from: fromNumber,
        to: toNormalized,
        body,
        source: opts.source,
        twilioSid: data.sid,
        status: data.status || 'queued',
        sentByUserId: opts.sentByUserId
      });
      await bumpConversationAfterOutbound(conversation.id, body);
    }

    return {
      ok: true,
      sid: data.sid,
      messageId,
      conversationId: conversation ? conversation.id : null
    };

  } catch (e) {
    console.error('sendSms error:', e.message);
    if (conversation) {
      await logOutboundSms({
        conversationId: conversation.id,
        subaccountId,
        from: fromNumber,
        to: toNormalized,
        body,
        source: opts.source,
        status: 'failed',
        error: e.message,
        sentByUserId: opts.sentByUserId
      });
    }
    return { ok: false, error: e.message };
  }
}

module.exports = {
  sendSms,
  getSmsSettings,
  getTwilioCreds,
  normalizePhone,
  inboundWebhookUrl,
  statusCallbackUrl,
  setInboundWebhook,
  syncTwilioInboundConfig,
  findOrCreateSmsConversation,
  logOutboundSms,
  bumpConversationAfterOutbound
};
