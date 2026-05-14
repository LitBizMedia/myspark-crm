// POST /api/sms/status
//
// Twilio delivery status callback. Twilio POSTs delivery state updates here
// for outbound messages (sent via Message Create with StatusCallback set).
//
// Status flow: queued -> sent -> delivered (or failed/undelivered)
//
// Updates conversation_messages.status by external_id = MessageSid.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

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

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let params;
  if (typeof req.body === 'string') {
    params = parseFormUrlEncoded(req.body);
  } else {
    params = req.body || {};
  }

  const twilioSid = params.MessageSid;
  const status = params.MessageStatus; // queued, sending, sent, delivered, failed, undelivered
  const errorCode = params.ErrorCode;
  const errorMessage = errorCode ? 'Twilio error code: ' + errorCode : null;

  if (twilioSid && status) {
    try {
      // Update by external_id (Twilio SID) regardless of which conversation it belongs to
      const updates = [status];
      let q = `UPDATE conversation_messages SET status = $1`;
      if (errorMessage) {
        q += `, error = $2 WHERE external_id = $3`;
        updates.push(errorMessage, twilioSid);
      } else {
        q += ` WHERE external_id = $2`;
        updates.push(twilioSid);
      }
      const result = await db.query(q, updates);
      if (result.rowCount === 0) {
        console.warn('Status callback for unknown twilioSid:', twilioSid, 'status:', status);
      }
    } catch (e) {
      console.error('Status update failed:', e.message);
    }
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
}

exports.handler = wrap(handler);
