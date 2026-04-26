// api/sms/webhook.js
// Receives delivery status callbacks from Twilio.
// Updates sms_log for analytics and failure tracking.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

async function updateSmsLog(twilioSid, status, errorMessage) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !twilioSid) return;
  const url = SUPABASE_URL + '/rest/v1/sms_log?twilio_sid=eq.' + encodeURIComponent(twilioSid);
  const body = { status };
  if (errorMessage) body.error_message = errorMessage;
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('updateSmsLog error:', e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const params = req.body || {};
  const twilioSid = params.MessageSid;
  const status = params.MessageStatus;
  const errorCode = params.ErrorCode;
  const errorMessage = errorCode ? 'Twilio error code: ' + errorCode : null;

  if (twilioSid && status) {
    await updateSmsLog(twilioSid, status, errorMessage);
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
};
