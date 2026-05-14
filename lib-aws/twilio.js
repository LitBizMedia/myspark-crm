// lib/twilio.js
// Shared SMS sending helper using Twilio.
//
// Reads credentials from AWS Secrets Manager (myspark/integrations/twilio).
// Falls back to env vars for local development.
// Writes SMS messages to conversations + conversation_messages (NOT sms_log).
// Sets Twilio statusCallback so we can track delivery state.

const crypto = require('crypto');
const db = require('./db');
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

// Normalize a phone number to E.164. Best-effort. Returns null on bad input.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already E.164
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  // 10-digit US format
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

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

  const settings = await getSmsSettings(subaccountId);
  if (!settings) return { ok: false, error: 'SMS not configured for this workspace' };
  // Single status gate: only 'live' allows sending
  if (settings.campaign_status === 'pending') return { ok: false, error: 'SMS campaign is pending carrier approval' };
  if (settings.campaign_status === 'paused') return { ok: false, error: 'SMS is paused for this workspace' };
  if (settings.campaign_status !== 'live') return { ok: false, error: 'SMS is not yet active for this workspace' };
  if (!settings.twilio_number) return { ok: false, error: 'No Twilio number assigned to this workspace' };

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
  findOrCreateSmsConversation,
  logOutboundSms,
  bumpConversationAfterOutbound
};
