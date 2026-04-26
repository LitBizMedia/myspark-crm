// api/sms/send.js
// POST endpoint for sending SMS via Twilio.
// Only sends if subaccount has an approved campaign and enabled SMS.

const { sendSms } = require('../../lib/twilio');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, to, body, templateType, contactId, vars } = req.body || {};

  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!body) return res.status(400).json({ error: 'body is required' });

  const result = await sendSms(slug, { to, body, templateType, contactId, vars });

  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json({ success: true, sid: result.sid });
};
