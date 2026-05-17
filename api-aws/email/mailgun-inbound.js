// api/email/mailgun-inbound.js (Lambda)
//
// Mailgun inbound webhook handler.
//
// Triggered by Mailgun route when an email arrives at reply.mysparkplus.app
// or any other inbound domain we register. Mailgun POSTs a multipart/form-data
// payload containing parsed email metadata + body. We verify signature, find
// the conversation by reply token, store the inbound message.
//
// Flow:
//   1. Verify HMAC signature using webhook signing key
//   2. Parse multipart/form-data body (busboy)
//   3. Extract reply+TOKEN@ from recipient
//   4. Look up conversation by reply_token
//   5. Insert conversation_messages row (direction='inbound')
//   6. Update conversation aggregates
//   7. Or log to inbound_unmatched if no match
//
// Mailgun fields received (subset):
//   recipient         - To address (reply+TOKEN@domain)
//   sender            - From address (email only)
//   from              - From header (full "Name <email>")
//   subject           - Subject
//   body-plain        - Plain text body (with quoted reply)
//   body-html         - HTML body
//   stripped-text     - Plain text WITHOUT quoted reply (Mailgun parsed)
//   stripped-html     - HTML WITHOUT quoted reply
//   Message-Id        - Original Message-ID header
//   In-Reply-To       - Message-ID this is replying to
//   References        - Full reference chain
//   timestamp         - Unix timestamp (for sig)
//   token             - Webhook signature token
//   signature         - HMAC SHA-256 of timestamp+token using signing key
//
// CREDENTIALS: AWS Secrets Manager at myspark/integrations/mailgun

const db = require('./lib/db');
const crypto = require('crypto');
const Busboy = require('busboy');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SECRET_NAME = 'myspark/integrations/mailgun';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);

// ─── Credentials cache ────────────────────────────────────────────

let _cachedCreds = null;
const secretsClient = new SecretsManagerClient({ region: AWS_REGION });

async function getCredentials() {
  if (_cachedCreds) return _cachedCreds;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  _cachedCreds = JSON.parse(result.SecretString);
  return _cachedCreds;
}

// ─── Helpers ──────────────────────────────────────────────────────

function wrapMid(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  if (s[0] === '<' && s[s.length - 1] === '>') return s;
  return '<' + s + '>';
}

// Find reply+TOKEN@<anything> in the recipient (Mailgun gives us one string,
// not an array). Falls back to scanning To header if recipient doesn't match.
function extractReplyToken(recipient, toHeader) {
  const tryString = function(s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/reply\+([a-f0-9]{32})@/i);
    if (m) return { token: m[1].toLowerCase(), address: s };
    return null;
  };
  return tryString(recipient) || tryString(toHeader);
}

// ─── Signature verification ───────────────────────────────────────

function verifySignature(timestamp, token, signature, signingKey) {
  if (!timestamp || !token || !signature || !signingKey) return false;

  // Reject if timestamp is older than 15 min (replay attack defense)
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 900) {
    console.warn('mailgun-inbound: timestamp out of window', { now, ts });
    return false;
  }

  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch (e) {
    // Buffer length mismatch throws on timingSafeEqual
    return false;
  }
}

// ─── Multipart parser ─────────────────────────────────────────────

// Mailgun sends a multipart/form-data body. We extract fields into a flat
// object. Attachments are received but currently ignored (Phase 5+ work).
function parseMultipart(rawBody, contentType) {
  return new Promise(function(resolve, reject) {
    const fields = {};
    const attachments = [];

    let bb;
    try {
      bb = Busboy({ headers: { 'content-type': contentType } });
    } catch (e) {
      return reject(new Error('Busboy init error: ' + e.message));
    }

    bb.on('field', function(name, value) {
      fields[name] = value;
    });

    bb.on('file', function(name, file, info) {
      // Consume the stream so busboy can finish, but discard for now
      const chunks = [];
      file.on('data', function(d) { chunks.push(d); });
      file.on('end', function() {
        attachments.push({
          fieldName: name,
          filename: info.filename,
          mimeType: info.mimeType,
          size: Buffer.concat(chunks).length
        });
      });
    });

    bb.on('error', function(err) {
      reject(new Error('Multipart parse error: ' + err.message));
    });

    bb.on('close', function() {
      resolve({ fields, attachments });
    });

    bb.end(rawBody);
  });
}

// ─── Unmatched logging ────────────────────────────────────────────

async function logUnmatched(toAddr, fromAddr, subject, payload, reason) {
  try {
    await db.insertOne('inbound_unmatched', {
      to_address: toAddr || null,
      from_address: fromAddr || null,
      subject: subject || null,
      raw_payload: payload || {},
      reason: reason || 'unknown'
    });
  } catch (e) {
    console.error('mailgun-inbound: logUnmatched error:', e.message);
  }
}

// ─── Main processor ───────────────────────────────────────────────

async function processInbound(fields) {
  const recipient = fields.recipient || '';
  const toHeader = fields.To || fields.to || '';
  const fromAddr = fields.sender || (fields.from || '').match(/<([^>]+)>/) ?
    (fields.sender || ((fields.from || '').match(/<([^>]+)>/) || [])[1]) :
    (fields.from || '');
  const subject = fields.subject || '';

  // Prefer stripped-text over body-plain (no quoted reply garbage)
  const bodyText = fields['stripped-text'] || fields['body-plain'] || null;
  const bodyHtml = fields['stripped-html'] || fields['body-html'] || null;

  const externalMessageId = fields['Message-Id'] || fields['message-id'] || null;
  const inReplyTo = fields['In-Reply-To'] || fields['in-reply-to'] || null;
  const receivedAt = fields.timestamp ?
    new Date(parseInt(fields.timestamp, 10) * 1000).toISOString() :
    new Date().toISOString();

  // Extract reply token
  const tokenMatch = extractReplyToken(recipient, toHeader);
  if (!tokenMatch) {
    console.log('mailgun-inbound: no reply token in recipient', recipient, 'to:', toHeader);
    await logUnmatched(recipient || toHeader, fromAddr, subject, { recipient, toHeader }, 'no_token_in_address');
    return { processed: false, reason: 'no_token' };
  }

  // Look up conversation
  let conv;
  try {
    conv = await db.findOne('conversations',
      { reply_token: tokenMatch.token },
      { select: 'id, subaccount_id, contact_id, channel, status, unread_count' }
    );
  } catch (e) {
    console.error('mailgun-inbound: conversation lookup error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, { token: tokenMatch.token }, 'lookup_error');
    return { processed: false, reason: 'lookup_error' };
  }

  if (!conv) {
    console.log('mailgun-inbound: no conversation matched token', tokenMatch.token);
    await logUnmatched(tokenMatch.address, fromAddr, subject, { token: tokenMatch.token }, 'token_not_found');
    return { processed: false, reason: 'token_not_found' };
  }

  // Insert inbound message
  const msgId = 'msg_' + uid();
  try {
    await db.insertOne('conversation_messages', {
      id: msgId,
      conversation_id: conv.id,
      subaccount_id: conv.subaccount_id,
      direction: 'inbound',
      channel: 'email',
      source: 'manual',
      from_address: fromAddr,
      to_address: tokenMatch.address,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      external_id: externalMessageId,
      external_message_id: wrapMid(externalMessageId),
      in_reply_to: wrapMid(inReplyTo),
      status: 'received',
      sent_at: receivedAt
    });
  } catch (e) {
    console.error('mailgun-inbound: insert error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, { token: tokenMatch.token }, 'insert_error');
    return { processed: false, reason: 'insert_error' };
  }

  // Update conversation aggregates
  const now = new Date().toISOString();
  const preview = (bodyText || subject || '').slice(0, 140);
  const updates = {
    last_message_at: now,
    last_inbound_message_at: now,
    last_message_preview: preview,
    last_message_direction: 'inbound',
    unread_count: (conv.unread_count || 0) + 1,
    updated_at: now
  };
  if (conv.status === 'closed' || conv.status === 'archived') {
    updates.status = 'open';
  }
  try {
    await db.update('conversations', updates, { id: conv.id });
  } catch (e) {
    console.error('mailgun-inbound: aggregate update error:', e.message);
  }

  console.log('mailgun-inbound: stored msg_id=' + msgId + ' conv_id=' + conv.id);
  return { processed: true, conversationId: conv.id, messageId: msgId };
}

// ─── Lambda handler ───────────────────────────────────────────────

exports.handler = async (event, context) => {
  // API Gateway HTTP API v2 event shape
  try {
    const headers = event.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || '';

    if (!contentType.includes('multipart/form-data')) {
      console.warn('mailgun-inbound: unexpected content-type:', contentType);
      return { statusCode: 400, body: JSON.stringify({ error: 'expected multipart/form-data' }) };
    }

    // API Gateway v2 base64-encodes binary bodies
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'utf-8');

    const { fields } = await parseMultipart(rawBody, contentType);

    // Signature verification
    const creds = await getCredentials();
    const signingKey = creds.MAILGUN_WEBHOOK_SIGNING_KEY;
    const valid = verifySignature(
      fields.timestamp,
      fields.token,
      fields.signature,
      signingKey
    );

    if (!valid) {
      console.warn('mailgun-inbound: signature verification FAILED');
      return { statusCode: 401, body: JSON.stringify({ error: 'invalid signature' }) };
    }

    // Process the inbound email
    const result = await processInbound(fields);

    // Always return 200 to Mailgun (even on internal failures), otherwise
    // Mailgun retries up to 8 hours. We've already logged what went wrong.
    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (e) {
    console.error('mailgun-inbound: handler error:', e.message, e.stack);
    // Still return 200 to prevent Mailgun retries
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
