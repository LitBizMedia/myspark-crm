// api/email/send.js
// POST endpoint for sending transactional emails via Resend.
// Accepts vars object for template variable substitution.
// Called by other serverless functions, not directly by the client.

const { sendEmail } = require('../../lib/resend');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug, to, subject, html, text, fromName, templateType, contactId, vars } = req.body || {};

  if (!slug) return res.status(400).json({ error: 'slug is required' });
  if (!to) return res.status(400).json({ error: 'to is required' });

  if (!templateType && !subject) return res.status(400).json({ error: 'subject is required' });
  if (!templateType && !html) return res.status(400).json({ error: 'html is required' });

  const result = await sendEmail(slug, { to, subject, html, text, fromName, templateType, contactId, vars });

  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json({ success: true, id: result.id });
};
