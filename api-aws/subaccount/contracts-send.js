// api-aws/subaccount/contracts-send.js
//
// Action Lambda: creates a contract envelope and sends signing request email.
// One atomic operation: validate -> render -> insert envelope -> send email.
//
// Route: POST /api/subaccount/contracts/send
// Body:  { template_id, contact_id, appointment_id?, expiration_days? }
//
// See docs/MySpark-Contracts-Spec.md (Stage 3)

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');
const crypto = require('crypto');
const contracts = require('./lib/contracts');
const tokens = require('./lib/contract-tokens');
const sanitize = require('./lib/html-sanitize');
const templateVars = require('./lib/template-vars');
const mailgun = require('./lib/mailgun');

const SIGNING_BASE_URL = 'https://sign.mysparkplus.app';

// Default email template provisioned per-subaccount on first send.
// Stored in email_templates; subaccount admin can edit later via UI.
const DEFAULT_EMAIL_SUBJECT = '{{sender_name}} sent you a document to sign';
const DEFAULT_EMAIL_HTML = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
<tr><td style="padding:24px 32px;background:#6b21ea;color:#ffffff">
<div style="font-size:20px;font-weight:700">{{business_name}}</div>
</td></tr>
<tr><td style="padding:32px">
<h1 style="margin:0 0 16px;font-size:22px;color:#1a1030;font-weight:700">Document ready for signature</h1>
<p style="margin:0 0 16px;color:#5a4d7a;line-height:1.6;font-size:14px">Hi {{contact_first_name}},</p>
<p style="margin:0 0 24px;color:#5a4d7a;line-height:1.6;font-size:14px">{{sender_name}} has sent you a document to review and sign: <strong>{{title}}</strong></p>
<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px"><tr><td style="border-radius:8px;background:#f97316">
<a href="{{signing_url}}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px">Sign Document</a>
</td></tr></table>
<p style="margin:0 0 16px;font-size:13px;color:#5a4d7a;line-height:1.6">This signing link will expire on <strong>{{expiration_date}}</strong>. After that, you will need a new link to sign.</p>
<p style="margin:0;font-size:13px;color:#5a4d7a;line-height:1.6">Questions? Reply to this email or contact {{business_email}}.</p>
</td></tr>
<tr><td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
Sent securely by {{business_name}} via MySpark+
</td></tr>
</table>
</td></tr>
</table>`;

function genId(prefix){
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}${rnd}`.slice(0, 24);
}

function formatDate(date){
  if(!date) return '';
  const d = (date instanceof Date) ? date : new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Build the variable context for a contract from contact + subaccount + appointment.
// Returns flat snake_case object compatible with template-vars.resolveTemplate.
async function buildContractContext({ subaccountId, contactId, appointmentId, senderId, expiresAt }) {
  // Subaccount
  const subR = await db.query(
    `SELECT id, slug, name, admin_email, settings FROM subaccounts WHERE id = $1`,
    [subaccountId]
  );
  const sub = subR.rows[0];
  if (!sub) throw new Error('subaccount not found');
  const subSettings = sub.settings || {};

  // Contact (with PHI fields needed for substitution)
  const cR = await db.query(
    `SELECT id, first_name, last_name, display_name, email, phone, date_of_birth,
            address_line1, address_line2, city, state, postal_code,
            custom_field_values, email_suppressed, archived
       FROM contacts WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, contactId]
  );
  const c = cR.rows[0];
  if (!c) throw new Error('contact not found');

  // Sender (subaccount_user)
  let sender = null;
  if (senderId) {
    const senderR = await db.query(
      `SELECT id, display_name, email FROM subaccount_users WHERE id = $1`,
      [senderId]
    );
    sender = senderR.rows[0] || null;
  }

  // Appointment (optional)
  let appt = null;
  if (appointmentId) {
    const apptR = await db.query(
      `SELECT a.id, a.title, a.date, a.time, a.duration, a.assigned_to,
              s.name AS service_name,
              su.display_name AS staff_display_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN subaccount_users su ON su.id::text = a.assigned_to
        WHERE a.subaccount_id = $1 AND a.id = $2 AND a.contact_id = $3`,
      [subaccountId, appointmentId, contactId]
    );
    appt = apptR.rows[0] || null;
    if (!appt) throw new Error('appointment not found or does not belong to this contact');
  }

  // Build context (snake_case flat)
  const today = new Date();
  const ctx = {
    // Contact
    contact_name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
    contact_first_name: c.first_name || '',
    contact_last_name: c.last_name || '',
    contact_email: c.email || '',
    contact_phone: c.phone || '',
    contact_dob: c.date_of_birth ? formatDate(c.date_of_birth) : '',
    contact_address: [
      c.address_line1, c.address_line2, c.city, c.state, c.postal_code
    ].filter(Boolean).join(', '),
    contact_address_line1: c.address_line1 || '',
    contact_city: c.city || '',
    contact_state: c.state || '',
    contact_zip: c.postal_code || '',

    // Business (from subaccount columns; settings JSONB fallback)
    business_name: subSettings.businessName || subSettings.business_name || sub.name || '',
    business_email: subSettings.businessEmail || subSettings.business_email || sub.admin_email || '',
    business_phone: subSettings.businessPhone || subSettings.business_phone || '',
    business_address: subSettings.businessAddress || subSettings.business_address || '',

    // Sender
    sender_name: sender ? (sender.display_name || sender.email || '') : '',
    sender_email: sender ? (sender.email || '') : '',
    staff_name: sender ? (sender.display_name || '') : '',

    // Dates
    today_date: formatDate(today),
    signing_date: formatDate(today),
    expiration_date: formatDate(expiresAt)
  };

  // Appointment fields (only if linked)
  if (appt) {
    ctx.appointment_date = formatDate(appt.date);
    ctx.appointment_time = appt.time || '';
    ctx.appointment_service = appt.service_name || appt.title || '';
    ctx.appointment_staff = appt.staff_display_name || '';
    ctx.appointment_duration = appt.duration ? (appt.duration + ' min') : '';
  } else {
    ctx.appointment_date = '';
    ctx.appointment_time = '';
    ctx.appointment_service = '';
    ctx.appointment_staff = '';
    ctx.appointment_duration = '';
  }

  // Custom field passthrough: {{custom:field_key}}
  const customFields = c.custom_field_values || {};
  for (const key of Object.keys(customFields)) {
    ctx['custom:' + key] = customFields[key] != null ? String(customFields[key]) : '';
  }

  return {
    context: ctx,
    contact: c,
    subaccount: sub,
    sender: sender,
    appointment: appt
  };
}

// Auto-provision the contract_signing_request email template for this subaccount.
// Idempotent: only inserts if missing. enabled=true so mailgun.getTemplate finds it.
async function ensureSigningEmailTemplate(subaccountId) {
  const existing = await db.query(
    `SELECT id FROM email_templates
       WHERE subaccount_id = $1 AND template_type = 'contract_signing_request' AND enabled = TRUE
       LIMIT 1`,
    [subaccountId]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO email_templates
       (id, subaccount_id, template_type, name, subject, body_html, is_default, enabled, created_at, updated_at)
     VALUES ($1, $2, 'contract_signing_request', 'Contract Signing Request', $3, $4, TRUE, TRUE, NOW(), NOW())`,
    [id, subaccountId, DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_HTML]
  );
  return id;
}

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if ((req.method || '').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const template_id = body.template_id;
  const contact_id = body.contact_id;
  const appointment_id = body.appointment_id || null;
  const expiration_days = body.expiration_days;

  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  if (!contact_id)  return res.status(400).json({ error: 'contact_id required' });

  const subaccountId = auth.subaccount_id;
  const senderId = auth.user_id;

  // 1. Fetch template (must be active, must belong to subaccount)
  const tmpl = await contracts.getTemplate(subaccountId, template_id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  if (!tmpl.active) return res.status(400).json({ error: 'Template is inactive' });

  // 2. Compute expires_at
  const expDays = (expiration_days && Number.isInteger(expiration_days) && expiration_days >= 1 && expiration_days <= 365)
    ? expiration_days
    : (tmpl.defaultExpirationDays || 30);
  const expiresAt = new Date(Date.now() + expDays * 86400000);

  // 3. Build context (fetches contact, subaccount, sender, appointment with validation)
  let ctxBundle;
  try {
    ctxBundle = await buildContractContext({
      subaccountId, contactId: contact_id, appointmentId: appointment_id, senderId, expiresAt
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { context, contact, subaccount, sender } = ctxBundle;

  // 4. Recipient validation
  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
  if (contact.archived) return res.status(400).json({ error: 'Contact is archived' });
  if (contact.email_suppressed) return res.status(400).json({ error: 'Contact email is suppressed' });

  // 5. Substitute variables in body_html, then sanitize
  const rendered = templateVars.resolveTemplate(tmpl.bodyHtml, context, { escape: true });
  const cleanHtml = sanitize.sanitize(rendered.html);

  // 6. Generate envelope ID and token
  const envelopeId = genId('env');
  const expSeconds = Math.floor(expiresAt.getTime() / 1000);
  const token = await tokens.signToken({ envelopeId, exp: expSeconds });
  const tokenHash = tokens.hashToken(token);

  // 7. Recipient name snapshot for envelope row
  const recipientName = contact.display_name
    || [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    || contact.email;
  const senderName = sender ? (sender.display_name || sender.email || auth.username) : auth.username;

  // 8. INSERT envelope as 'sent' (email send next; if it fails, we void)
  try {
    await db.query(
      `INSERT INTO contract_envelopes
        (id, subaccount_id, template_id, contact_id,
         recipient_name, recipient_email,
         sender_id, sender_name,
         title, body_html, variables_snapshot, agree_text,
         status, token_hash, expires_at,
         sent_at, appointment_id, require_email_verification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               'sent', $13, $14, NOW(), $15, $16)`,
      [
        envelopeId, subaccountId, template_id, contact_id,
        recipientName, contact.email,
        senderId, senderName,
        tmpl.name, cleanHtml, JSON.stringify(rendered.snapshot), tmpl.defaultAgreeText,
        tokenHash, expiresAt, appointment_id, !!tmpl.requireEmailVerification
      ]
    );
  } catch (e) {
    console.error('contracts-send: envelope insert failed:', e);
    return res.status(500).json({ error: 'Failed to create envelope', detail: e.message });
  }

  // 9. Auto-provision email template (idempotent)
  try {
    await ensureSigningEmailTemplate(subaccountId);
  } catch (e) {
    console.warn('contracts-send: email template auto-provision failed (non-fatal):', e.message);
  }

  // 10. Build signing URL and email variables
  const signingUrl = `${SIGNING_BASE_URL}/${envelopeId}/${token}`;
  const emailVars = Object.assign({}, context, {
    title: tmpl.name,
    signing_url: signingUrl
  });

  // 11. Derive slug from subaccount_id (strip 'sub-' prefix)
  const slug = subaccount.slug || subaccountId.replace(/^sub-/, '');

  // 12. Send email
  let sendResult;
  try {
    sendResult = await mailgun.sendEmail(slug, {
      scope: 'subaccount',
      to: contact.email,
      contactId: contact_id,
      templateType: 'contract_signing_request',
      vars: emailVars
    });
  } catch (e) {
    console.error('contracts-send: mailgun threw:', e);
    sendResult = { ok: false, error: e.message };
  }

  if (!sendResult || !sendResult.ok) {
    // Void the envelope; the email never went out
    const reason = (sendResult && sendResult.error) ? sendResult.error : 'unknown email error';
    await db.query(
      `UPDATE contract_envelopes
         SET status = 'voided', voided_at = NOW(), voided_by = $1, void_reason = $2
         WHERE id = $3`,
      [senderId, 'email_send_failed: ' + reason.slice(0, 200), envelopeId]
    ).catch(e => console.error('void update failed:', e));

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contract.send_failed',
      targetType: 'contract_envelope',
      targetId: envelopeId,
      targetSubaccountId: subaccountId,
      metadata: { template_id, contact_id, reason: reason.slice(0, 200) }
    });

    return res.status(502).json({ error: 'Email send failed', detail: reason });
  }

  // 13. Increment template send_count
  await contracts.incrementTemplateCount(subaccountId, template_id, 'send_count')
    .catch(e => console.warn('send_count increment failed:', e));

  // 14. Audit log success
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract.send',
    targetType: 'contract_envelope',
    targetId: envelopeId,
    targetSubaccountId: subaccountId,
    metadata: {
      template_id,
      contact_id,
      appointment_id,
      recipient_email: contact.email,
      expires_at: expiresAt.toISOString(),
      variables_used: rendered.used,
      variables_missing: rendered.missing
    }
  });

  // 15. Return success
  return res.status(201).json({
    ok: true,
    envelope_id: envelopeId,
    status: 'sent',
    expires_at: expiresAt.toISOString(),
    recipient: { name: recipientName, email: contact.email }
  });
}

exports.handler = wrap(handler);
