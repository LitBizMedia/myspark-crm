// api/email/webhook.js (Lambda version - Secrets Manager)
//
// POST /api/email/webhook
//
// Single endpoint for ALL Resend webhook events.
// Resend sends all event types to one URL; we route by event.type:
//
//   email.delivered / email.bounced / email.complained
//     → update message status (conversation_messages first, agency_email_log fallback)
//
//   email.received
//     → parse reply token from To address
//     → look up conversation by reply_token
//     → fetch body from Resend API
//     → insert inbound message + update conversation aggregates
//     → log to inbound_unmatched if no match
//
// CREDENTIALS:
//   RESEND_WEBHOOK_SECRET from Secrets Manager (Svix signature verification)
//   RESEND_API_KEY        from Secrets Manager (body fetch for inbound emails)

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const crypto = require('crypto');

// ─── Signature verification ──────────────────────────────────────

async function getWebhookSecret() {
  return secrets.getKey('myspark/integrations/resend', 'RESEND_WEBHOOK_SECRET');
}

async function getApiKey() {
  return secrets.getKey('myspark/integrations/resend', 'RESEND_API_KEY');
}

async function verifySignature(rawBody, headers) {
  const webhookSecret = await getWebhookSecret();
  if (!webhookSecret || webhookSecret === 'PLACEHOLDER') {
    console.warn('RESEND_WEBHOOK_SECRET not configured - rejecting webhook');
    return false;
  }
  const svixId = headers['svix-id'] || headers['Svix-Id'];
  const svixTimestamp = headers['svix-timestamp'] || headers['Svix-Timestamp'];
  const svixSignature = headers['svix-signature'] || headers['Svix-Signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secret = Buffer.from(webhookSecret.replace('whsec_', ''), 'base64');
  const signedContent = svixId + '.' + svixTimestamp + '.' + rawBody;
  const computed = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');

  const signatures = svixSignature.split(' ');
  return signatures.some(sig => {
    const sigValue = sig.startsWith('v1,') ? sig.slice(3) : sig;
    return sigValue === computed;
  });
}

// ─── Delivery status updates (outbound emails) ────────────────────

const STATUS_MAP = {
  'email.delivered': 'delivered',
  'email.bounced':   'bounced',
  'email.complained': 'complained'
};

// Try conversation_messages first, fall back to agency_email_log.
async function updateMessageStatus(resendId, status, errorMessage) {
  if (!resendId) return;
  try {
    const cmResult = await db.update('conversation_messages',
      { status, error: errorMessage || null },
      { external_id: resendId }
    );
    const cmRows = (cmResult && (cmResult.rowCount || cmResult.affectedRows || (Array.isArray(cmResult) ? cmResult.length : 0))) || 0;
    if (cmRows > 0) return;

    const aglUpdates = { status };
    if (errorMessage) aglUpdates.error_message = errorMessage;
    const aglResult = await db.update('agency_email_log', aglUpdates, { resend_email_id: resendId });
    const aglRows = (aglResult && (aglResult.rowCount || aglResult.affectedRows || (Array.isArray(aglResult) ? aglResult.length : 0))) || 0;
    if (aglRows === 0) {
      console.warn('updateMessageStatus: no matching message for resend_email_id=' + resendId);
    }
  } catch (e) {
    console.error('updateMessageStatus error:', e.message);
  }
}

// ─── Inbound email handling (email.received) ──────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
}

// Find a reply+TOKEN@<anything> address in the recipients array.
// Returns { token, address } or null.
function extractReplyToken(toArray) {
  if (!Array.isArray(toArray)) return null;
  for (const addr of toArray) {
    if (!addr || typeof addr !== 'string') continue;
    const m = addr.match(/reply\+([a-f0-9]{32})@/i);
    if (m) return { token: m[1].toLowerCase(), address: addr };
  }
  return null;
}

// Fetch the full received email from Resend's API to get the body.
// Returns { text, html } or null on failure.
async function fetchReceivedEmail(emailId) {
  if (!emailId) return null;
  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.error('fetchReceivedEmail: no API key');
      return null;
    }
    const res = await fetch('https://api.resend.com/emails/' + emailId, {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (!res.ok) {
      console.error('fetchReceivedEmail: HTTP ' + res.status);
      return null;
    }
    const detail = await res.json();
    return {
      text: detail.text || null,
      html: detail.html || null
    };
  } catch (e) {
    console.error('fetchReceivedEmail error:', e.message);
    return null;
  }
}

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
    console.error('logUnmatched error:', e.message);
  }
}

async function handleInboundEmail(evt) {
  const data = evt.data || {};
  const emailId = data.email_id;
  const toArray = data.to || [];
  const fromAddr = data.from || '';
  const subject = data.subject || '';
  const externalMessageId = data.message_id || null;
  const receivedAt = data.created_at || new Date().toISOString();

  // Extract reply token from To address
  const tokenMatch = extractReplyToken(toArray);
  if (!tokenMatch) {
    await logUnmatched(toArray.join(','), fromAddr, subject, evt, 'no_token_in_address');
    return;
  }

  // Look up conversation by reply_token
  let conv;
  try {
    conv = await db.findOne('conversations',
      { reply_token: tokenMatch.token },
      { select: 'id, subaccount_id, contact_id, channel, status, unread_count' }
    );
  } catch (e) {
    console.error('Conversation lookup error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, evt, 'lookup_error');
    return;
  }

  if (!conv) {
    await logUnmatched(tokenMatch.address, fromAddr, subject, evt, 'token_not_found');
    return;
  }

  // Fetch full body from Resend API
  const body = await fetchReceivedEmail(emailId);
  const bodyText = body && body.text;
  const bodyHtml = body && body.html;

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
      external_id: emailId,
      external_message_id: externalMessageId,
      status: 'received',
      sent_at: receivedAt
    });
  } catch (e) {
    console.error('Inbound message insert error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, evt, 'insert_error');
    return;
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
    console.error('Conversation aggregate update error:', e.message);
  }

  console.log('inbound message stored: ' + msgId + ' for conv ' + conv.id);
}

// ─── Handler ──────────────────────────────────────────────────────

exports.handler = async function (event, context) {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    headers[k.toLowerCase()] = v;
  }

  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let rawBody = event.body || '';
  if (event.isBase64Encoded && rawBody) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }

  // Test-mode bypass: allow direct Lambda invocation (no API Gateway) to skip signature.
  // event.test_mode is only present when invoked directly (never set by API Gateway).
  const isTestMode = event.test_mode === true;

  if (!isTestMode && !(await verifySignature(rawBody, headers))) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid signature' })
    };
  }

  let evt;
  try {
    evt = JSON.parse(rawBody);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  if (!evt || !evt.type) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid event' })
    };
  }

  // Route by event type
  if (evt.type === 'email.received') {
    await handleInboundEmail(evt);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
  }

  // Delivery status events
  const status = STATUS_MAP[evt.type];
  if (status) {
    const emailId = evt.data && evt.data.email_id;
    if (emailId) {
      const bounceMessage = (evt.type === 'email.bounced' && evt.data && evt.data.bounce)
        ? evt.data.bounce.message
        : null;
      await updateMessageStatus(emailId, status, bounceMessage);
    }
  }

  // Unknown event types: 200 OK (don't make Resend retry forever)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received: true })
  };
};
