// api/email/webhook.js (Lambda version - Secrets Manager)
//
// POST /api/email/webhook
//
// Receives Resend delivery status webhooks. Validates Svix signature.
//
// CREDENTIALS: RESEND_WEBHOOK_SECRET from Secrets Manager.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const crypto = require('crypto');

async function getWebhookSecret() {
  return secrets.getKey('myspark/integrations/resend', 'RESEND_WEBHOOK_SECRET');
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

async function updateEmailLog(resendId, status, errorMessage) {
  if (!resendId) return;
  const updates = { status };
  if (errorMessage) updates.error_message = errorMessage;
  try {
    await db.update('email_log', updates, { resend_email_id: resendId });
  } catch (e) {
    console.error('updateEmailLog error:', e.message);
  }
}

const STATUS_MAP = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained'
};

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

  if (!(await verifySignature(rawBody, headers))) {
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

  const emailId = evt.data && evt.data.email_id;
  if (!emailId) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
  }

  const status = STATUS_MAP[evt.type];
  if (!status) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
  }

  const bounceMessage = (evt.type === 'email.bounced' && evt.data && evt.data.bounce)
    ? evt.data.bounce.message
    : null;

  await updateEmailLog(emailId, status, bounceMessage);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received: true })
  };
};
