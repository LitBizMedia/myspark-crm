// lib/resend.js
// Shared email sending helper using Resend.
//
// Routes logs by scope:
//   scope='subaccount' → conversations + conversation_messages (patient comms, threading)
//   scope='agency'     → agency_email_log (admin/owner comms, no threading)
//
// CREDENTIALS: Loads RESEND_API_KEY from AWS Secrets Manager
// (myspark/integrations/resend) on first use. Cached for the lifetime
// of the Lambda container. Falls back to process.env.RESEND_API_KEY
// for local development.
//
// USAGE:
//   await sendEmail(slug, {
//     scope: 'subaccount' | 'agency',   // REQUIRED (defaults to subaccount with warning)
//     to: 'patient@example.com',
//     subject: 'Reminder: appointment tomorrow',
//     html: '<p>...</p>',
//     text: 'optional plain text',
//     templateType: 'appt-reminder',     // optional, loads template if present
//     vars: { name: 'Jane' },            // optional, used with templateType
//     contactId: 'mocyg...',             // REQUIRED for scope='subaccount'
//     source: 'reminder'|'manual'|'confirmation'|'cancellation'|'widget'|'system',
//     sentByUserId: 'user-id',           // optional, for manual sends
//     fromName: 'Clinic Name'            // optional override
//   });

const db = require('./db');
const secrets = require('./secrets');
const crypto = require('crypto');

const FALLBACK_DOMAIN = 'mysparkplus.app';

const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
const replyToken = () => crypto.randomBytes(16).toString('hex');  // 32-char hex

// ─── API key loading ─────────────────────────────────────────────

let _apiKey = undefined;  // undefined = not loaded, null = tried and failed
async function getApiKey() {
  if (_apiKey !== undefined) return _apiKey;
  _apiKey = (await secrets.getKey('myspark/integrations/resend', 'RESEND_API_KEY')) || null;
  if (!_apiKey) {
    console.error('lib/resend.js: RESEND_API_KEY not available in Secrets Manager or env.');
  }
  return _apiKey;
}

// ─── Domain + template lookup ─────────────────────────────────────

async function getVerifiedDomain(subaccountId) {
  try {
    const row = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId, status: 'verified' },
      { select: 'domain, inbound_subdomain, inbound_status' }
    );
    return row || null;
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

// ─── Conversation upsert ──────────────────────────────────────────

// Find or create the email conversation for (subaccount_id, contact_id).
// Returns { id, reply_token } or null on failure.
async function upsertConversation(subaccountId, contactId) {
  if (!subaccountId || !contactId) return null;
  try {
    const existing = await db.findOne('conversations',
      { subaccount_id: subaccountId, contact_id: contactId, channel: 'email' },
      { select: 'id, reply_token' }
    );
    if (existing) return existing;

    const id = 'conv_' + uid();
    const token = replyToken();
    await db.insertOne('conversations', {
      id,
      subaccount_id: subaccountId,
      contact_id: contactId,
      channel: 'email',
      status: 'open',
      reply_token: token
    }, { returning: 'id' });
    return { id, reply_token: token };
  } catch (e) {
    console.error('upsertConversation error:', e.message);
    return null;
  }
}

// ─── Logging: subaccount scope ────────────────────────────────────

// Insert conversation_messages row and update conversation aggregates.
async function logSubaccountMessage(subaccountId, conversation, fields) {
  if (!conversation) return;
  const msgId = 'msg_' + uid();
  const source = fields.source || 'system';
  const isManual = source === 'manual';
  const status = fields.status || 'sent';
  const now = new Date().toISOString();

  try {
    await db.insertOne('conversation_messages', {
      id: msgId,
      conversation_id: conversation.id,
      subaccount_id: subaccountId,
      direction: 'outbound',
      channel: 'email',
      source,
      from_address: fields.from || null,
      to_address: fields.to,
      subject: fields.subject || null,
      body_text: fields.text || null,
      body_html: fields.html || null,
      external_id: fields.resendId || null,
      status,
      error: fields.error || null,
      sent_by_user_id: fields.sentByUserId || null,
      sent_at: now
    }, { returning: 'id' });

    // Update conversation aggregates only on non-failed sends
    if (status !== 'failed') {
      const preview = (fields.subject || '').slice(0, 140);
      const updates = {
        last_message_at: now,
        last_message_preview: preview,
        last_message_direction: 'outbound',
        updated_at: now
      };
      // Only manual sends bump inbox-sort timestamp; system messages stay quiet
      if (isManual) {
        updates.last_manual_message_at = now;
      }
      await db.update('conversations', updates, { id: conversation.id });
    }
  } catch (e) {
    console.error('logSubaccountMessage error:', e.message);
  }
}

// ─── Logging: agency scope ────────────────────────────────────────

async function logAgencyMessage(fields) {
  try {
    await db.insertOne('agency_email_log', {
      recipient_email: fields.to,
      recipient_subaccount_id: fields.subaccountId || null,
      from_email: fields.from,
      subject: fields.subject || null,
      template_type: fields.templateType || null,
      resend_email_id: fields.resendId || null,
      status: fields.status || 'sent',
      error_message: fields.error || null
    });
  } catch (e) {
    console.error('logAgencyMessage error:', e.message);
  }
}

// ─── Main send function ───────────────────────────────────────────

async function sendEmail(slug, opts) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  if (!opts || !opts.to) {
    return { ok: false, error: 'to is required' };
  }

  // Scope routing. Default 'subaccount' for backward compat, with warning.
  let scope = opts.scope;
  if (!scope) {
    console.warn('lib/resend.js: opts.scope missing; defaulting to "subaccount". Caller should declare scope explicitly.');
    scope = 'subaccount';
  }
  if (scope !== 'agency' && scope !== 'subaccount') {
    return { ok: false, error: 'Invalid scope: ' + scope };
  }

  // Subaccount sends require slug. Agency sends may omit slug (use fallback domain).
  if (scope === 'subaccount' && !slug) {
    return { ok: false, error: 'slug is required for subaccount-scope sends' };
  }
  const subaccountId = slug ? ('sub-' + slug) : null;

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

  const domainRow = subaccountId ? await getVerifiedDomain(subaccountId) : null;
  const fromDomain = (domainRow && domainRow.domain) || FALLBACK_DOMAIN;
  const fromName = opts.fromName || 'MySpark+';
  const fromEmail = 'noreply@' + fromDomain;
  const from = fromName + ' <' + fromEmail + '>';

  // Subaccount scope: find/create conversation, generate Reply-To if inbound configured
  let conversation = null;
  let replyTo = null;
  if (scope === 'subaccount') {
    if (opts.contactId) {
      conversation = await upsertConversation(subaccountId, opts.contactId);
      if (conversation && domainRow && domainRow.inbound_status === 'verified') {
        const sub = domainRow.inbound_subdomain || 'reply';
        replyTo = 'reply+' + conversation.reply_token + '@' + sub + '.' + fromDomain;
      }
    } else {
      console.warn('lib/resend.js: subaccount-scope send with no contactId; message will not be threaded.');
    }
  }

  const payload = {
    from: from,
    to: [opts.to],
    subject: subject,
    html: html
  };
  if (opts.text) payload.text = opts.text;
  if (replyTo) payload.reply_to = [replyTo];

  // Common log fields
  function buildLogFields(status, resendId, error) {
    return {
      to: opts.to,
      from: fromEmail,
      subject,
      html,
      text: opts.text,
      templateType: opts.templateType,
      resendId,
      status,
      error,
      source: opts.source,
      sentByUserId: opts.sentByUserId,
      subaccountId: subaccountId || opts.subaccountId || null
    };
  }

  function logResult(status, resendId, error) {
    const fields = buildLogFields(status, resendId, error);
    if (scope === 'subaccount' && conversation) {
      return logSubaccountMessage(subaccountId, conversation, fields);
    }
    return logAgencyMessage(fields);
  }

  let res, data;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    data = await res.json();
  } catch (e) {
    console.error('sendEmail fetch error:', e.message);
    await logResult('failed', null, e.message);
    return { ok: false, error: e.message };
  }

  if (!res.ok) {
    const err = data.message || 'Resend error ' + res.status;
    await logResult('failed', null, err);
    return { ok: false, error: err };
  }

  await logResult('sent', data.id, null);
  return {
    ok: true,
    id: data.id,
    conversation_id: conversation ? conversation.id : null
  };
}

// ─── Exports ──────────────────────────────────────────────────────

async function getResendApiKey() {
  return getApiKey();
}

async function getResendWebhookSecret() {
  return secrets.getKey('myspark/integrations/resend', 'RESEND_WEBHOOK_SECRET');
}

module.exports = { sendEmail, getResendApiKey, getResendWebhookSecret };
