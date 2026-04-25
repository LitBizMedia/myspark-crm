// lib/resend.js
// Shared email sending helper using Resend.
// Uses Supabase service_role key for logging and template lookup.
// Never import this from client-side code. For /api/* only.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FALLBACK_DOMAIN = 'mysparkplus.app';

if (!RESEND_API_KEY) {
  console.error('lib/resend.js: Missing RESEND_API_KEY environment variable.');
}

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

async function getVerifiedDomain(subaccountId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = SUPABASE_URL + '/rest/v1/subaccount_email_domains'
    + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
    + '&status=eq.verified&select=domain&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].domain;
  } catch (e) {
    console.error('getVerifiedDomain error:', e.message);
    return null;
  }
}

async function getTemplate(subaccountId, templateType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !templateType) return null;
  const url = SUPABASE_URL + '/rest/v1/email_templates'
    + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
    + '&template_type=eq.' + encodeURIComponent(templateType)
    + '&enabled=eq.true&select=subject,body_html&limit=1';
  try {
    const res = await fetch(url, { headers: svcHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0];
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const body = {
    subaccount_id: subaccountId,
    to_email: fields.to,
    from_email: fields.from,
    subject: fields.subject || null,
    template_type: fields.templateType || null,
    resend_email_id: fields.resendId || null,
    status: fields.status || 'sent',
    error_message: fields.error || null,
    contact_id: fields.contactId || null
  };
  try {
    await fetch(SUPABASE_URL + '/rest/v1/email_log', {
      method: 'POST',
      headers: svcHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('logEmail error:', e.message);
  }
}

async function sendEmail(slug, opts) {
  if (!RESEND_API_KEY) {
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
        'Authorization': 'Bearer ' + RESEND_API_KEY,
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

module.exports = { sendEmail };
