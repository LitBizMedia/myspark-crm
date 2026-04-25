// api/email/webhook.js
// Receives delivery status webhooks from Resend.
// Validates Svix signature before processing.
// Updates email_log for analytics, bounce tracking, and complaint handling.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

function verifySignature(rawBody, headers) {
  if (!RESEND_WEBHOOK_SECRET) return false;
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secret = Buffer.from(RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
  const signedContent = svixId + '.' + svixTimestamp + '.' + rawBody;
  const computed = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');

  const signatures = svixSignature.split(' ');
  return signatures.some(sig => {
    const sigValue = sig.startsWith('v1,') ? sig.slice(3) : sig;
    return sigValue === computed;
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function updateEmailLog(resendId, status, errorMessage) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !resendId) return;
  const url = SUPABASE_URL + '/rest/v1/email_log?resend_email_id=eq.' + encodeURIComponent(resendId);
  const body = { status };
  if (errorMessage) body.error_message = errorMessage;
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('updateEmailLog error:', e.message);
  }
}

const STATUS_MAP = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained'
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);

  if (!verifySignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!event || !event.type) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  const emailId = event.data && event.data.email_id;
  if (!emailId) return res.status(200).json({ received: true });

  const status = STATUS_MAP[event.type];
  if (!status) return res.status(200).json({ received: true });

  const bounceMessage = (event.type === 'email.bounced' && event.data && event.data.bounce)
    ? event.data.bounce.message
    : null;

  await updateEmailLog(emailId, status, bounceMessage);

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false }
};
