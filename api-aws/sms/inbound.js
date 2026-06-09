// POST /api/sms/inbound
//
// Twilio inbound SMS webhook. Twilio POSTs form-encoded data to this URL when
// a patient texts one of our Twilio numbers.
//
// Flow:
//   1. Parse Twilio form payload
//   2. Look up sms_settings by recipient number (To) to find subaccount
//   3. Find or create contact by sender phone (From) via lib/contacts
//   4. Find or create SMS conversation
//   5. Insert inbound message into conversation_messages
//   6. Update conversation aggregates (unread, last_message_at, preview)
//   7. Return empty TwiML so Twilio doesn't auto-reply

const crypto = require('crypto');
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { getContactByPhone, createStubContactFromSms, setSmsConsent } = require('./lib/contacts');
const { logAudit } = require('./lib/audit');

// Match the email-conversation token format used elsewhere
const replyToken = () => crypto.randomBytes(16).toString('hex');

function parseFormUrlEncoded(body) {
  const result = {};
  if (typeof body !== 'string' || !body) return result;
  body.split('&').forEach(function(pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    result[key] = val;
  });
  return result;
}

// Find the subaccount that owns the recipient Twilio number
async function findSubaccountByNumber(twilioNumber) {
  if (!twilioNumber) return null;
  const r = await db.query(
    `SELECT subaccount_id FROM sms_settings WHERE twilio_number = $1 LIMIT 1`,
    [twilioNumber]
  );
  return r.rows.length ? r.rows[0].subaccount_id : null;
}

async function findOrCreateSmsConversation(subaccountId, contactId) {
  const existing = await db.query(
    `SELECT * FROM conversations
     WHERE subaccount_id = $1 AND contact_id = $2 AND channel = 'sms'
     ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
    [subaccountId, contactId]
  );
  if (existing.rows.length) return existing.rows[0];

  const convId = 'conv_' + Math.random().toString(36).slice(2, 14);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO conversations
       (id, subaccount_id, contact_id, channel, status, unread_count, reply_token, created_at, updated_at)
     VALUES ($1, $2, $3, 'sms', 'open', 0, $4, $5, $5)`,
    [convId, subaccountId, contactId, replyToken(), now]
  );
  const fresh = await db.query(`SELECT * FROM conversations WHERE id = $1`, [convId]);
  return fresh.rows[0];
}

async function logUnmatched(toNumber, fromNumber, body, reason) {
  try {
    await db.query(
      `INSERT INTO agency_email_log (id, kind, reason, payload, created_at)
       VALUES (gen_random_uuid()::text, 'sms_inbound_unmatched', $1, $2::jsonb, NOW())`,
      [reason, JSON.stringify({ to: toNumber, from: fromNumber, body: (body || '').slice(0, 500) })]
    );
  } catch (e) {
    console.error('logUnmatched failed:', e.message);
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let params;
  if (typeof req.body === 'string') {
    params = parseFormUrlEncoded(req.body);
  } else {
    params = req.body || {};
  }

  const fromNumber = params.From;
  const toNumber = params.To;
  const body = params.Body || '';
  const twilioSid = params.MessageSid;

  if (!fromNumber || !toNumber) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  try {
    // Which subaccount owns this number?
    const subaccountId = await findSubaccountByNumber(toNumber);
    if (!subaccountId) {
      console.warn('Inbound SMS to unknown number:', toNumber, 'from', fromNumber);
      await logUnmatched(toNumber, fromNumber, body, 'unknown_recipient_number');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    // Find or create contact via canonical lib
    let contact = await getContactByPhone(subaccountId, fromNumber);
    let contactId;
    if (contact) {
      contactId = contact.id;
    } else {
      contactId = await createStubContactFromSms(subaccountId, fromNumber);
      if (!contactId) {
        await logUnmatched(toNumber, fromNumber, body, 'contact_create_failed');
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send('<Response></Response>');
      }
    }

    // Find or create conversation
    const conv = await findOrCreateSmsConversation(subaccountId, contactId);

    // Compliance keyword detection. Exact match only (uppercased, trimmed) so
    // "stop by tomorrow" never triggers. Twilio also handles the carrier-level
    // block; this syncs our DB so the contact drawer reflects reality and the
    // opt-out is recorded in the audit log per TCPA/HIPAA.
    const kw = (body || '').trim().toUpperCase();
    const OPT_OUT = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
    const OPT_IN  = ['START', 'YES', 'UNSTOP'];
    let isKeyword = false;
    if (OPT_OUT.indexOf(kw) !== -1) {
      isKeyword = true;
      // STOP blocks the number for everything on the carrier side, so both
      // flags go false to keep our data truthful.
      const chg = await setSmsConsent(subaccountId, contactId,
        { transactional: false, marketing: false, source: 'sms_keyword_stop' });
      await logAudit({
        req, actorType: 'public', actorId: contactId,
        actorUsername: fromNumber, action: 'subaccount.contact.sms_opt_out',
        targetType: 'contact', targetId: contactId, targetSubaccountId: subaccountId,
        metadata: { keyword: kw, changed: !!(chg && chg.changed) }
      });
    } else if (OPT_IN.indexOf(kw) !== -1) {
      isKeyword = true;
      // START restores transactional reachability only. Marketing requires a
      // deliberate opt-in flow (higher consent bar), so it stays as-is.
      const chg = await setSmsConsent(subaccountId, contactId,
        { transactional: true, source: 'sms_keyword_start' });
      await logAudit({
        req, actorType: 'public', actorId: contactId,
        actorUsername: fromNumber, action: 'subaccount.contact.sms_opt_in',
        targetType: 'contact', targetId: contactId, targetSubaccountId: subaccountId,
        metadata: { keyword: kw, changed: !!(chg && chg.changed) }
      });
    }

    // Insert message
    const msgId = 'msg_' + Math.random().toString(36).slice(2, 18);
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO conversation_messages
         (id, conversation_id, subaccount_id, direction, channel, source,
          from_address, to_address, body_text, external_id, external_message_id,
          status, sent_at, created_at)
       VALUES ($1, $2, $3, 'inbound', 'sms', 'manual', $4, $5, $6, $7, $7, 'received', $8, $8)`,
      [msgId, conv.id, subaccountId, fromNumber, toNumber, body, twilioSid || null, now]
    );

    // Bump conversation aggregates
    const preview = body.slice(0, 140);
    await db.query(
      `UPDATE conversations
       SET last_message_at = $1,
           last_inbound_message_at = $1,
           last_message_preview = $2,
           last_message_direction = 'inbound',
           unread_count = unread_count + (CASE WHEN $4 THEN 0 ELSE 1 END),
           status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
           updated_at = $1
       WHERE id = $3`,
      [now, preview, conv.id, isKeyword]
    );

    console.log('Inbound SMS processed:', { subaccountId, contactId, convId: conv.id, msgId });
  } catch (err) {
    console.error('Inbound SMS handler error:', err.message);
    // Don't return an error to Twilio - they'll retry, causing duplicates
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
}

exports.handler = wrap(handler);
