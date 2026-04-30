// lib/resend.js
// Shared email sending helper using Resend.
// Uses RDS for logging and template lookup.
// Never import this from client-side code. For /api/* only.
//
// CREDENTIALS: Loads RESEND_API_KEY from AWS Secrets Manager
// (myspark/integrations/resend) on first use. Cached for the lifetime
// of the Lambda container. Falls back to process.env.RESEND_API_KEY
// for local development.

const db = require('./db');
const secrets = require('./secrets');

const FALLBACK_DOMAIN = 'mysparkplus.app';

// Lazy load API key from Secrets Manager. Returns null if not available.
let _apiKey = undefined;  // undefined = not loaded yet, null = tried and failed
async function getApiKey() {
  if (_apiKey !== undefined) return _apiKey;
  _apiKey = (await secrets.getKey('myspark/integrations/resend', 'RESEND_API_KEY')) || null;
  if (!_apiKey) {
    console.error('lib/resend.js: RESEND_API_KEY not available in Secrets Manager or env.');
  }
  return _apiKey;
}

async function getVerifiedDomain(subaccountId) {
  try {
    const row = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId, status: 'verified' },
      { select: 'domain' }
    );
    return row ? row.domain : null;
  } catch (e) {
    console.error('getVerifiedDomain error:', e.message);
    return null;
  }
}

async function getTemplate(subaccountId, templateType) {
  if (!templateType) return null;
  try {
    const row = await db.findOne('email_templates',
      { subaccount_id: subaccountId, template_type: templateType, enabled: true },
      { select: 'subject, body_html' }
    );
    return row || null;
  } catch (e) {
    console.error('getTemplate error:', e.message);
    return null;
  }
}

function applyVars(str, vars) {
  if (!str || !vars) return str;
  return Object.keys(vars).reduce(function(result, key) {
    const token = '{{' + key + '}}';
    return result.split(token).join(vars[key] != null ? String(vars[key]) : '');
  }, str);
}

async function logEmail(subaccountId, fields) {
  const row = {
    subaccount_id:    subaccountId,
    to_email:         fields.to,
    from_email:       fields.from,
    subject:          fields.subject || null,
    template_type:    fields.templateType || null,
    resend_email_id:  fields.resendId || null,
    status:           fields.status || 'sent',
    error_message:    fields.error || null,
    contact_id:       fields.contactId || null
  };
  try {
    await db.insertOne('email_log', row, { returning: 'id' });
  } catch (e) {
    console.error('logEmail error:', e.message);
  }
}

async function sendEmail(slug, opts) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  if (!opts || !opts.to) {
    return { ok: false, error: 'to is required' };
  }

  const subaccountId = 'sub-' + slug;

  let subject = opts.subject;
  let html = opts.html;

  if (opts.templateType) {
    const tpl = await getTemplate(subaccountId, opts.templateType);
    if (tpl && opts.vars) {
      subject = applyVars(tpl.subject, opts.vars);
      html = applyVars(tpl.body_html, opts.vars);
    }
  }

  if (!subject || !html) {
    return { ok: false, error: 'subject and html are required (no saved template found)' };
  }

  const verifiedDomain = await getVerifiedDomain(subaccountId);
  const fromDomain = verifiedDomain || FALLBACK_DOMAIN;
  const fromName = opts.fromName || 'MySpark+';
  const fromEmail = 'noreply@' + fromDomain;
  const from = fromName + ' <' + fromEmail + '>';

  const payload = {
    from: from,
    to: [opts.to],
    subject: subject,
    html: html
  };
  if (opts.text) payload.text = opts.text;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      await logEmail(subaccountId, {
        to: opts.to,
        from: fromEmail,
        subject: subject,
        templateType: opts.templateType,
        contactId: opts.contactId,
        status: 'failed',
        error: data.message || 'Resend error ' + res.status
      });
      return { ok: false, error: data.message || 'Send failed' };
    }

    await logEmail(subaccountId, {
      to: opts.to,
      from: fromEmail,
      subject: subject,
      templateType: opts.templateType,
      contactId: opts.contactId,
      resendId: data.id,
      status: 'sent'
    });

    return { ok: true, id: data.id };

  } catch (e) {
    console.error('sendEmail error:', e.message);
    await logEmail(subaccountId, {
      to: opts.to,
      from: fromEmail,
      subject: subject,
      templateType: opts.templateType,
      contactId: opts.contactId,
      status: 'failed',
      error: e.message
    });
    return { ok: false, error: e.message };
  }
}

// Exposed so endpoints that need the API key directly (e.g. webhook signature
// verification, domain management) can pull it the same way.
async function getResendApiKey() {
  return getApiKey();
}

async function getResendWebhookSecret() {
  return secrets.getKey('myspark/integrations/resend', 'RESEND_WEBHOOK_SECRET');
}

module.exports = { sendEmail, getResendApiKey, getResendWebhookSecret };
