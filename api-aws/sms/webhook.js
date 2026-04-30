// api/sms/webhook.js (Lambda version)
//
// POST /api/sms/webhook
//
// Receives delivery status callbacks from Twilio.
// Twilio sends application/x-www-form-urlencoded data, not JSON.
// Returns TwiML XML response.
//
// IMPORTANT: This endpoint uses raw body parsing because Twilio sends
// form-encoded data, not JSON. The lambda-adapter parses JSON only on
// Content-Type=application/json, so form data falls through as raw string -
// we parse it manually here.
//
// MIGRATED: Supabase REST → lib/db.js for sms_log update.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

function parseFormUrlEncoded(body) {
  const result = {};
  if (typeof body !== 'string' || !body) return result;
  body.split('&').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    result[key] = val;
  });
  return result;
}

async function updateSmsLog(twilioSid, status, errorMessage) {
  if (!twilioSid) return;
  const updates = { status };
  if (errorMessage) updates.error_message = errorMessage;
  try {
    await db.update('sms_log', updates, { twilio_sid: twilioSid });
  } catch (e) {
    console.error('updateSmsLog error:', e.message);
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Twilio sends application/x-www-form-urlencoded.
  // The lambda-adapter only auto-parses JSON, so req.body is either:
  //   - A raw string if Content-Type is form-encoded (most common from Twilio)
  //   - Already an object if something upstream parsed it
  let params;
  if (typeof req.body === 'string') {
    params = parseFormUrlEncoded(req.body);
  } else {
    params = req.body || {};
  }

  const twilioSid = params.MessageSid;
  const status = params.MessageStatus;
  const errorCode = params.ErrorCode;
  const errorMessage = errorCode ? 'Twilio error code: ' + errorCode : null;

  if (twilioSid && status) {
    await updateSmsLog(twilioSid, status, errorMessage);
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
}

exports.handler = wrap(handler);
