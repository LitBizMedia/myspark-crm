// api/email/webhook.js
// Receives delivery status webhooks from Resend.
// Updates email_log for analytics, bounce tracking, and complaint handling.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
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
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained'
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;
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
