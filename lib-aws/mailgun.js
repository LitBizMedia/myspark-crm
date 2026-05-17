// lib/mailgun.js
// Shared email sending helper using Mailgun HTTP API.
//
// Drop-in replacement for lib/ses.js. Same interface, same DB writes,
// same scope routing, same Reply-To token threading.
//
// Routes logs by scope:
//   scope='subaccount' → conversations + conversation_messages (patient comms, threading)
//   scope='agency'     → agency_email_log (admin/owner comms, no threading)
//
// Threading (RFC 5322):
//   Every outbound gets a Message-ID we control. We pass it to Mailgun via header
//   "h:Message-Id" and Mailgun preserves it on the wire. Future replies use this
//   as In-Reply-To and recipient clients thread correctly.
//
// CREDENTIALS: AWS Secrets Manager at myspark/integrations/mailgun.
//   Loaded once per Lambda container, cached in module scope.

const db = require('./db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const FALLBACK_DOMAIN = 'mg.mysparkplus.app';
const FALLBACK_FROM_NAME = 'MySpark+';
const SECRET_NAME = 'myspark/integrations/mailgun';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
const replyToken = () => crypto.randomBytes(16).toString('hex');

// ─── Credentials cache ────────────────────────────────────────────

let _cachedCreds = null;
const secretsClient = new SecretsManagerClient({ region: AWS_REGION });

async function getCredentials() {
  if (_cachedCreds) return _cachedCreds;
  try {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    _cachedCreds = JSON.parse(result.SecretString);
    return _cachedCreds;
  } catch (e) {
    console.error('Mailgun credentials fetch failed:', e.message);
    throw new Error('Mailgun credentials unavailable: ' + e.message);
  }
}

// Build a Message-ID we control, using Mailgun's recommended pattern.
// Format: <{uuid}@{domain}>
function buildMessageId(domain) {
  const id = crypto.randomBytes(20).toString('hex');
  return '<' + id + '@' + domain + '>';
}

// ─── Domain + template lookup ─────────────────────────────────────

async function getVerifiedDomain(subaccountId) {
  try {
    const row = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId, status: 'verified' },
      { select: 'domain, inbound_subdomain, inbound_status, inbound_mode, sending_mode, grace_period_ends_at, grace_period_blocked, mailgun_sending_key' }
    );
    return row || null;
  } catch (e) {
    console.error('getVerifiedDomain error:', e.message);
    return null;
  }
}

async function getSubaccountDomainConfig(subaccountId) {
  try {
    const row = await db.findOne('subaccount_email_domains',
      { subaccount_id: subaccountId },
      { select: 'domain, status, inbound_subdomain, inbound_status, inbound_mode, sending_mode, grace_period_ends_at, grace_period_blocked, mailgun_sending_key' }
    );
    return row || null;
  } catch (e) {
    console.error('getSubaccountDomainConfig error:', e.message);
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
      external_id: fields.mailgunMessageId || null,
      external_message_id: fields.messageIdHeader || null,
      in_reply_to: fields.inReplyTo || null,
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
      resend_email_id: fields.mailgunMessageId || null,
      status: fields.status || 'sent',
      error_message: fields.error || null
    });
  } catch (e) {
    console.error('logAgencyMessage error:', e.message);
  }
}

// ─── Raw MIME builder (for threading + custom headers) ────────────

async function buildRawMime({ from, to, subject, html, text, replyTo, messageId, inReplyTo, references }) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mailOptions = {
    from,
    to,
    subject,
    html,
    text: text || undefined
  };
  if (messageId) mailOptions.messageId = messageId;
  if (replyTo) mailOptions.replyTo = replyTo;
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
  if (references && references.length) mailOptions.references = references;

  return new Promise(function(resolve, reject) {
    transport.sendMail(mailOptions, function(err, info) {
      if (err) return reject(err);
      resolve(info.message);
    });
  });
}

// ─── Mailgun HTTP send ────────────────────────────────────────────

// Send raw MIME via Mailgun's messages.mime endpoint using the form-data
// package and node's https module. This is the production-grade pattern;
// native FormData/Blob+fetch handles binary MIME unreliably in Node Lambda.
//
// docs: https://documentation.mailgun.com/en/latest/api-sending.html#sending
const FormData = require('form-data');
const https = require('https');
const { URL } = require('url');

async function mailgunSendMime({ apiKey, domain, rawMime, to }) {
  const creds = await getCredentials();
  const apiBase = creds.MAILGUN_API_BASE_URL || 'https://api.mailgun.net/v3';
  const urlString = apiBase + '/' + domain + '/messages.mime';
  const url = new URL(urlString);

  const form = new FormData();
  form.append('to', Array.isArray(to) ? to.join(',') : to);
  form.append('message', rawMime, {
    filename: 'message.mime',
    contentType: 'message/rfc822'
  });

  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const headers = form.getHeaders();
  headers['Authorization'] = 'Basic ' + auth;

  return new Promise(function(resolve, reject) {
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      port: url.port || 443,
      headers: headers,
      timeout: 25000  // 25 sec, well under Lambda default 30s
    }, function(res) {
      const chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch (e) { body = { message: text }; }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Mailgun API ' + res.statusCode + ': ' + (body.message || text)));
        }

        // Mailgun returns: { id: '<message-id>', message: 'Queued. Thank you.' }
        const idHeader = body.id || null;
        const idClean = idHeader ? idHeader.replace(/^<|>$/g, '') : null;
        resolve({
          mailgunId: idClean,
          messageIdHeader: idHeader
        });
      });
    });

    req.on('error', function(err) {
      reject(new Error('Mailgun HTTPS error: ' + err.message));
    });

    req.on('timeout', function() {
      req.destroy();
      reject(new Error('Mailgun request timeout after 25s'));
    });

    form.pipe(req);
  });
}

// ─── Main send function ───────────────────────────────────────────

async function sendEmail(slug, opts) {
  if (!opts || !opts.to) {
    return { ok: false, error: 'to is required' };
  }

  let scope = opts.scope;
  if (!scope) {
    console.warn('lib/mailgun.js: opts.scope missing; defaulting to "subaccount". Caller should declare scope explicitly.');
    scope = 'subaccount';
  }
  if (scope !== 'agency' && scope !== 'subaccount') {
    return { ok: false, error: 'Invalid scope: ' + scope };
  }

  if (scope === 'subaccount' && !slug) {
    return { ok: false, error: 'slug is required for subaccount-scope sends' };
  }
  const subaccountId = slug ? ('sub-' + slug) : null;

  // Load creds early to fail fast on misconfiguration.
  const creds = await getCredentials();

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

  // ─── Determine sending domain, mode, and grace period status ────
  const domainConfig = subaccountId ? await getSubaccountDomainConfig(subaccountId) : null;

  // Decision tree:
  //   1. No subaccount (agency-scope send) → use default agency domain
  //   2. Subaccount, branded mode, verified → use their domain
  //   3. Subaccount, shared mode (or unverified branded) → use default agency domain
  //   4. Subaccount past grace period AND blocked → reject

  const useBranded = (
    domainConfig &&
    domainConfig.sending_mode === 'branded' &&
    domainConfig.status === 'verified' &&
    domainConfig.domain
  );

  // Grace period enforcement (only for subaccount-scope sends in shared mode)
  if (scope === 'subaccount' && !useBranded && domainConfig) {
    if (domainConfig.grace_period_blocked === true) {
      const err = 'Email sending blocked: subaccount has not verified a sending domain within the grace period.';
      console.warn('lib/mailgun.js: blocked send for', subaccountId, err);
      // Still log to agency log so we can see attempts
      await logAgencyMessage({
        to: Array.isArray(opts.to) ? opts.to.join(',') : opts.to,
        from: 'blocked',
        subject,
        templateType: opts.templateType,
        status: 'blocked',
        error: err,
        subaccountId
      });
      return { ok: false, error: err, blocked: true };
    }
  }

  const fromDomain = useBranded ? domainConfig.domain : FALLBACK_DOMAIN;

  // Determine API key: per-domain key for branded, default key for shared
  const apiKey = (useBranded && domainConfig.mailgun_sending_key)
    ? domainConfig.mailgun_sending_key
    : creds.MAILGUN_DEFAULT_DOMAIN_KEY;

  // Determine local part of from address
  let fromLocal;
  if (useBranded) {
    fromLocal = creds.MAILGUN_BRANDED_DEFAULT_LOCAL || 'notifications';
  } else if (scope === 'subaccount') {
    fromLocal = creds.MAILGUN_SHARED_BOOKINGS_LOCAL || 'bookings';
  } else {
    // agency scope on shared domain
    fromLocal = 'notifications';
  }

  // Determine display name
  let fromName = opts.fromName;
  if (!fromName) {
    if (scope === 'subaccount' && subaccountId) {
      fromName = await getSubaccountName(subaccountId);
    }
    if (!fromName) fromName = creds.MAILGUN_DEFAULT_FROM_NAME || FALLBACK_FROM_NAME;
  }

  const fromEmail = fromLocal + '@' + fromDomain;
  const from = fromName + ' <' + fromEmail + '>';

  // ─── Conversation + reply-to threading (subaccount scope) ───────
  let conversation = null;
  let replyTo = null;
  if (scope === 'subaccount') {
    if (opts.contactId) {
      conversation = await upsertConversation(subaccountId, opts.contactId);
      if (conversation) {
        // Inbound subdomain selection:
        //   - Branded domain with verified inbound → reply.{theirdomain}
        //   - All others → reply.mysparkplus.app (shared inbound)
        if (useBranded && domainConfig.inbound_status === 'verified' && domainConfig.inbound_mode === 'branded') {
          const sub = domainConfig.inbound_subdomain || 'reply';
          replyTo = 'reply+' + conversation.reply_token + '@' + sub + '.' + fromDomain;
        } else {
          replyTo = 'reply+' + conversation.reply_token + '@reply.mysparkplus.app';
        }
      }
    } else {
      console.warn('lib/mailgun.js: subaccount-scope send with no contactId; message will not be threaded.');
    }
  }

  // ─── Build Message-ID and threading headers ─────────────────────
  const messageIdHeader = buildMessageId(fromDomain);

  const parent = opts.parentMessage || null;
  const inReplyTo = parent && parent.message_id_header ? parent.message_id_header : null;
  const references = parent && Array.isArray(parent.references) ? parent.references.slice() : [];
  if (inReplyTo && references.indexOf(inReplyTo) === -1) references.push(inReplyTo);

  function buildLogFields(status, mailgunMessageId, error) {
    return {
      to: Array.isArray(opts.to) ? opts.to.join(',') : opts.to,
      from: fromEmail,
      subject,
      html,
      text: opts.text,
      templateType: opts.templateType,
      mailgunMessageId,
      messageIdHeader,
      inReplyTo,
      status,
      error,
      source: opts.source,
      sentByUserId: opts.sentByUserId,
      subaccountId: subaccountId || opts.subaccountId || null
    };
  }

  function logResult(status, mailgunMessageId, error) {
    const fields = buildLogFields(status, mailgunMessageId, error);
    if (scope === 'subaccount' && conversation) {
      return logSubaccountMessage(subaccountId, conversation, fields);
    }
    return logAgencyMessage(fields);
  }

  // ─── Build raw MIME and send to Mailgun ─────────────────────────
  try {
    const rawBuffer = await buildRawMime({
      from,
      to: opts.to,
      subject,
      html,
      text: opts.text,
      replyTo,
      messageId: messageIdHeader,
      inReplyTo,
      references
    });

    const mgResult = await mailgunSendMime({
      apiKey,
      domain: fromDomain,
      rawMime: rawBuffer,
      to: opts.to
    });

    await logResult('sent', mgResult.mailgunId, null);

    return {
      ok: true,
      id: mgResult.mailgunId,
      messageIdHeader: mgResult.messageIdHeader || messageIdHeader,
      conversation_id: conversation ? conversation.id : null
    };
  } catch (e) {
    const errMsg = e.message || String(e);
    console.error('Mailgun send error:', errMsg);
    await logResult('failed', null, errMsg);
    return { ok: false, error: errMsg };
  }
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = { sendEmail };
