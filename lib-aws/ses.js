// lib/ses.js
// Shared email sending helper using AWS SES v2.
//
// Drop-in replacement for lib/resend.js. Same interface, same DB writes,
// same scope routing, same Reply-To token threading.
//
// Routes logs by scope:
//   scope='subaccount' → conversations + conversation_messages (patient comms, threading)
//   scope='agency'     → agency_email_log (admin/owner comms, no threading)
//
// CREDENTIALS: AWS SDK auto-loads from Lambda execution role.
// No Secrets Manager call required.
//
// USAGE (identical to lib/resend.js):
//   await sendEmail(slug, {
//     scope: 'subaccount' | 'agency',   // REQUIRED
//     to: 'patient@example.com',
//     subject: 'Reminder: appointment tomorrow',
//     html: '<p>...</p>',
//     text: 'optional plain text',
//     templateType: 'appt-reminder',
//     vars: { name: 'Jane' },
//     contactId: 'mocyg...',             // REQUIRED for scope='subaccount'
//     source: 'reminder'|'manual'|'confirmation'|'cancellation'|'widget'|'system',
//     sentByUserId: 'user-id',
//     fromName: 'Clinic Name'
//   });

const db = require('./db');
const crypto = require('crypto');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const FALLBACK_DOMAIN = 'mysparkplus.app';
const CONFIG_SET = 'myspark-events';  // SES configuration set for bounce/complaint tracking
const SES_REGION = process.env.AWS_REGION || 'us-east-2';

const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
const replyToken = () => crypto.randomBytes(16).toString('hex');

// SES client — auto-discovers credentials from Lambda execution role
const sesClient = new SESv2Client({ region: SES_REGION });

// ─── Domain + template lookup ─────────────────────────────────────

async function getVerifiedDomain(subaccountId) {
  try {
    const row = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId, status: 'verified' },
      { select: 'domain, inbound_subdomain, inbound_status, inbound_mode' }
    );
    return row || null;
  } catch (e) {
    console.error('getVerifiedDomain error:', e.message);
    return null;
  }
}

async function getSubaccountName(subaccountId) {
  if (!subaccountId) return null;
  try {
    const row = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'name' }
    );
    return (row && row.name) || null;
  } catch (e) {
    console.error('getSubaccountName error:', e.message);
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
      external_id: fields.sesMessageId || null,
      status,
      error: fields.error || null,
      sent_by_user_id: fields.sentByUserId || null,
      sent_at: now
    }, { returning: 'id' });

    if (status !== 'failed') {
      const preview = (fields.subject || '').slice(0, 140);
      const updates = {
        last_message_at: now,
        last_message_preview: preview,
        last_message_direction: 'outbound',
        updated_at: now
      };
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
      resend_email_id: fields.sesMessageId || null,  // column name retained for now
      status: fields.status || 'sent',
      error_message: fields.error || null
    });
  } catch (e) {
    console.error('logAgencyMessage error:', e.message);
  }
}

// ─── Main send function ───────────────────────────────────────────

async function sendEmail(slug, opts) {
  if (!opts || !opts.to) {
    return { ok: false, error: 'to is required' };
  }

  let scope = opts.scope;
  if (!scope) {
    console.warn('lib/ses.js: opts.scope missing; defaulting to "subaccount". Caller should declare scope explicitly.');
    scope = 'subaccount';
  }
  if (scope !== 'agency' && scope !== 'subaccount') {
    return { ok: false, error: 'Invalid scope: ' + scope };
  }

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

  // From name selection:
  //   - explicit opts.fromName always wins (callers like billing-emails set 'MySpark+ Billing')
  //   - subaccount-scope: pull from subaccounts.name (e.g. 'LitBiz Media')
  //   - agency-scope: 'MySpark+'
  let fromName = opts.fromName;
  if (!fromName) {
    if (scope === 'subaccount' && subaccountId) {
      fromName = await getSubaccountName(subaccountId);
    }
    if (!fromName) fromName = 'MySpark+';
  }

  const fromEmail = 'noreply@' + fromDomain;
  const from = fromName + ' <' + fromEmail + '>';

  let conversation = null;
  let replyTo = null;
  if (scope === 'subaccount') {
    if (opts.contactId) {
      conversation = await upsertConversation(subaccountId, opts.contactId);
      if (conversation && domainRow && domainRow.inbound_status === 'verified') {
        const sub = domainRow.inbound_subdomain || 'reply';
        const mode = domainRow.inbound_mode || 'shared';
        // shared: reply+TOKEN@reply.mysparkplus.app (single inbound domain for all subaccounts)
        // branded: reply+TOKEN@<sub>.<their-domain> (per-subaccount inbound subdomain)
        if (mode === 'branded') {
          replyTo = 'reply+' + conversation.reply_token + '@' + sub + '.' + fromDomain;
        } else {
          replyTo = 'reply+' + conversation.reply_token + '@' + sub + '.' + FALLBACK_DOMAIN;
        }
      }
    } else {
      console.warn('lib/ses.js: subaccount-scope send with no contactId; message will not be threaded.');
    }
  }

  // SES SendEmailCommand input
  const commandInput = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [opts.to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' }
        }
      }
    },
    ConfigurationSetName: CONFIG_SET
  };
  if (opts.text) {
    commandInput.Content.Simple.Body.Text = { Data: opts.text, Charset: 'UTF-8' };
  }
  if (replyTo) {
    commandInput.ReplyToAddresses = [replyTo];
  }

  function buildLogFields(status, sesMessageId, error) {
    return {
      to: opts.to,
      from: fromEmail,
      subject,
      html,
      text: opts.text,
      templateType: opts.templateType,
      sesMessageId,
      status,
      error,
      source: opts.source,
      sentByUserId: opts.sentByUserId,
      subaccountId: subaccountId || opts.subaccountId || null
    };
  }

  function logResult(status, sesMessageId, error) {
    const fields = buildLogFields(status, sesMessageId, error);
    if (scope === 'subaccount' && conversation) {
      return logSubaccountMessage(subaccountId, conversation, fields);
    }
    return logAgencyMessage(fields);
  }

  try {
    const result = await sesClient.send(new SendEmailCommand(commandInput));
    await logResult('sent', result.MessageId, null);
    return {
      ok: true,
      id: result.MessageId,
      conversation_id: conversation ? conversation.id : null
    };
  } catch (e) {
    const errMsg = e.message || String(e);
    console.error('SES send error:', errMsg);
    await logResult('failed', null, errMsg);
    return { ok: false, error: errMsg };
  }
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = { sendEmail };
