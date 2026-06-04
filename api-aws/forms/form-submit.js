// POST /api/forms/submit
//
// Public endpoint for form submissions from embedded forms. No auth, wide CORS.
//
// Responsibilities:
//   1. Send notification email to staff (if notify_email configured)
//   2. Resolve contact via identity match cascade (phone first, email second)
//   3. Auto-create new contact as lead, OR update existing fields, per form settings
//   4. Store SMS consent values on the resolved contact
//   5. Audit log
//
// Body shape:
//   {
//     subaccount_id, form_id, form_name,
//     notify_email,
//     submission_data: { first_name, last_name, email, phone, sms_consent: {...}, ... },
//     page_url,
//     honeypot,
//     create_contact: bool,   // form.settings.createContact
//     update_contact: bool    // form.settings.updateContact
//   }
//
// Returns:
//   { ok, submission_id, notification_sent, contact_id, contact_action }
//   contact_action: 'created' | 'updated' | 'matched' | 'skipped' | 'none'

const db = require('./lib/db');
const crypto = require('crypto');
const { wrap } = require('./lib/lambda-adapter');
const automations = require('./lib/automations');
const { sendEmail } = require('./lib/mailgun');
const { logAudit } = require('./lib/audit');
const { getContactByEmail, getContactByPhone, getContactById } = require('./lib/contacts');
const tokens = require('./lib/tokens');

const FALLBACK_DOMAIN = 'mysparkplus.app';
// Staff form-notification sends via Mailgun (lib/mailgun). SES removed (never approved out of sandbox).

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// Hash an IP for spam analytics without storing the raw value (GDPR alignment).
// SHA-256 truncated to 16 chars is plenty for our 'is this IP a known spammer?'
// use case while being practically irreversible.
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').substring(0, 16);
}

// Extract caller IP from the request. API Gateway HTTP API v2 puts it in
// requestContext.http.sourceIp. Fall back to x-forwarded-for header.
function extractIp(req) {
  try {
    const rc = req.requestContext || (req.event && req.event.requestContext);
    if (rc && rc.http && rc.http.sourceIp) return rc.http.sourceIp;
    const xff = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
    if (xff) return String(xff).split(',')[0].trim();
  } catch (e) {}
  return null;
}

function extractUserAgent(req) {
  try {
    return (req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || null;
  } catch (e) { return null; }
}

// Size cap on submission_data. DB has CHECK constraint at 100KB but we reject
// earlier at the Lambda to give a better error.
function isSubmissionSizeOk(data) {
  try {
    return Buffer.byteLength(JSON.stringify(data || {}), 'utf8') < 90000;
  } catch (e) { return false; }
}
function fmtFieldValue(val) {
  if (val == null || val === '') return '<em style="color:#999">empty</em>';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'object') return '<pre style="margin:0">' + esc(JSON.stringify(val, null, 2)) + '</pre>';
  return esc(String(val));
}
function fmtFieldKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildEmailHtml(formName, submissionData, pageUrl, submittedAt) {
  const rows = Object.keys(submissionData)
    .filter(k => k !== '_hp')
    .map(key => `
      <tr>
        <td style="padding:8px 14px;background:#f6f6f9;font-size:13px;font-weight:600;color:#444;border-bottom:1px solid #e8e8ee;width:35%;vertical-align:top">${esc(fmtFieldKey(key))}</td>
        <td style="padding:8px 14px;font-size:14px;color:#111;border-bottom:1px solid #e8e8ee;vertical-align:top">${fmtFieldValue(submissionData[key])}</td>
      </tr>
    `).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
      <div style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
        <div style="background:#6b21ea;color:#fff;padding:20px 24px">
          <div style="font-size:13px;opacity:.85;text-transform:uppercase;letter-spacing:.05em;font-weight:600">New Form Submission</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(formName)}</div>
        </div>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <div style="padding:16px 24px;background:#fafafd;font-size:12px;color:#666;border-top:1px solid #e8e8ee">
          <div><strong>Submitted at:</strong> ${esc(submittedAt)}</div>
          ${pageUrl ? `<div style="margin-top:4px"><strong>Page URL:</strong> ${esc(pageUrl)}</div>` : ''}
        </div>
      </div>
      <div style="text-align:center;font-size:11px;color:#999;padding:12px">Sent by MySpark+ Forms</div>
    </body></html>`;
}

function buildEmailText(formName, submissionData, pageUrl, submittedAt) {
  const lines = [
    'New form submission: ' + formName, '',
    ...Object.keys(submissionData).filter(k => k !== '_hp').map(k =>
      fmtFieldKey(k) + ': ' + (submissionData[k] == null || submissionData[k] === '' ? '(empty)' : (typeof submissionData[k] === 'object' ? JSON.stringify(submissionData[k]) : String(submissionData[k]))))
  ];
  lines.push('', 'Submitted at: ' + submittedAt);
  if (pageUrl) lines.push('Page URL: ' + pageUrl);
  return lines.join('\n');
}

// Identity match cascade: phone first, email second
async function resolveContact(subaccountId, submissionData) {
  const phone = safeStr(submissionData.phone);
  const email = safeStr(submissionData.email);
  if (phone) {
    const c = await getContactByPhone(subaccountId, phone);
    if (c) return c;
  }
  if (email) {
    const c = await getContactByEmail(subaccountId, email);
    if (c) return c;
  }
  return null;
}

// Build INSERT params from submission data. Composites (address, emergency_contact)
// are unpacked. Display name auto-derives from first+last.
function buildContactPayload(submissionData, formName) {
  const firstName = safeStr(submissionData.first_name);
  const lastName = safeStr(submissionData.last_name);
  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim()
    || safeStr(submissionData.email)
    || 'New Lead';

  // Address composite (sent as object {address_line1, city, state, postal_code})
  const addr = (submissionData.address && typeof submissionData.address === 'object') ? submissionData.address : {};
  // Emergency contact composite
  const emerg = (submissionData.emergency_contact && typeof submissionData.emergency_contact === 'object') ? submissionData.emergency_contact : {};

  // DOB validation
  let dob = safeStr(submissionData.dob || submissionData.date_of_birth);
  if (dob) {
    const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) dob = null;
    else {
      const y = parseInt(m[1], 10);
      if (y < 1900 || y > new Date().getUTCFullYear()) dob = null;
    }
  }

  return {
    first_name: firstName,
    last_name: lastName,
    display_name: displayName,
    email: safeStr(submissionData.email),
    phone: safeStr(submissionData.phone),
    date_of_birth: dob,
    gender: safeStr(submissionData.gender),
    pronouns: safeStr(submissionData.pronouns),
    preferred_language: safeStr(submissionData.language || submissionData.preferred_language),
    company: safeStr(submissionData.company),
    title: safeStr(submissionData.title),
    website: safeStr(submissionData.url || submissionData.website),
    address_line1: safeStr(addr.address_line1 || submissionData.address_line1),
    city: safeStr(addr.city),
    state: safeStr(addr.state),
    postal_code: safeStr(addr.postal_code),
    emergency_contact_name: safeStr(emerg.emergency_contact_name),
    emergency_contact_phone: safeStr(emerg.emergency_contact_phone),
    emergency_contact_relationship: safeStr(emerg.emergency_contact_relationship),
    source: 'Form: ' + formName
  };
}

async function createContactFromSubmission(subaccountId, submissionData, formName) {
  const payload = buildContactPayload(submissionData, formName);
  const id = 'cnt_' + Math.random().toString(36).slice(2, 14);
  const consent = submissionData.sms_consent || {};
  const hasConsent = (consent.transactional || consent.marketing);

  await db.query(
    `INSERT INTO contacts (
      id, subaccount_id,
      first_name, last_name, display_name,
      email, phone,
      date_of_birth, gender, pronouns, preferred_language,
      company, title, website,
      address_line1, city, state, postal_code, country,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      source, type, status, archived,
      tags, custom_field_values,
      sms_consent_transactional, sms_consent_marketing,
      sms_consent_updated_at, sms_consent_source,
      created_at, updated_at
    ) VALUES (
      $1, $2,
      $3, $4, $5,
      $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14,
      $15, $16, $17, $18, 'US',
      $19, $20, $21,
      $22, 'lead', 'active', false,
      '[]'::jsonb, '{}'::jsonb,
      $23, $24,
      ${hasConsent ? '$25' : 'NULL'}, ${hasConsent ? '$26' : 'NULL'},
      NOW(), NOW()
    )`,
    hasConsent ? [
      id, subaccountId,
      payload.first_name, payload.last_name, payload.display_name,
      payload.email, payload.phone,
      payload.date_of_birth, payload.gender, payload.pronouns, payload.preferred_language,
      payload.company, payload.title, payload.website,
      payload.address_line1, payload.city, payload.state, payload.postal_code,
      payload.emergency_contact_name, payload.emergency_contact_phone, payload.emergency_contact_relationship,
      payload.source,
      !!consent.transactional, !!consent.marketing,
      new Date().toISOString(), 'form_submission'
    ] : [
      id, subaccountId,
      payload.first_name, payload.last_name, payload.display_name,
      payload.email, payload.phone,
      payload.date_of_birth, payload.gender, payload.pronouns, payload.preferred_language,
      payload.company, payload.title, payload.website,
      payload.address_line1, payload.city, payload.state, payload.postal_code,
      payload.emergency_contact_name, payload.emergency_contact_phone, payload.emergency_contact_relationship,
      payload.source,
      false, false
    ]
  );
  return id;
}

// Fill-only update: only update fields where existing contact has null/empty
// Consent always overwrites because each form submission is a fresh consent act
async function updateContactFillOnly(subaccountId, existingContact, submissionData, formName) {
  const payload = buildContactPayload(submissionData, formName);
  const consent = submissionData.sms_consent || {};
  const hasConsent = (consent.transactional !== undefined || consent.marketing !== undefined);

  const sets = [];
  const params = [existingContact.id, subaccountId];
  let p = 3;

  // Fields to potentially update (fill-only)
  const fillFields = [
    'first_name', 'last_name', 'phone', 'date_of_birth', 'gender', 'pronouns',
    'preferred_language', 'company', 'title', 'website',
    'address_line1', 'city', 'state', 'postal_code',
    'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship'
  ];
  // Email: keep separate because it's the identity match key
  // If existing contact found via phone but has no email, fill in the email
  if (!existingContact.email && payload.email) {
    sets.push(`email = $${p++}`);
    params.push(payload.email);
  }
  fillFields.forEach(field => {
    const existingVal = existingContact[field];
    const newVal = payload[field];
    if ((!existingVal || existingVal === '') && newVal) {
      sets.push(`${field} = $${p++}`);
      params.push(newVal);
    }
  });

  // Consent always overwrites
  if (hasConsent) {
    if (consent.transactional !== undefined) {
      sets.push(`sms_consent_transactional = $${p++}`);
      params.push(!!consent.transactional);
    }
    if (consent.marketing !== undefined) {
      sets.push(`sms_consent_marketing = $${p++}`);
      params.push(!!consent.marketing);
    }
    sets.push(`sms_consent_updated_at = $${p++}`);
    params.push(new Date().toISOString());
    sets.push(`sms_consent_source = $${p++}`);
    params.push('form_submission');
  }

  if (sets.length === 0) return existingContact.id; // nothing to change

  sets.push(`updated_at = NOW()`);
  await db.query(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND subaccount_id = $2`,
    params
  );
  return existingContact.id;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};

    if (b.honeypot) {
      return res.status(200).json({ ok: true, submission_id: 'hp-' + Date.now() });
    }

    const subaccountId = b.subaccount_id;
    const formId = b.form_id;
    const formName = b.form_name || 'Form';
    const notifyEmail = (b.notify_email || '').trim();
    const submissionData = b.submission_data || {};
    const pageUrl = b.page_url || '';
    const createContact = b.create_contact !== false;
    const updateContact = b.update_contact !== false;
    const attributionToken = (b.t || b.token || '').trim();

    if (!subaccountId || !formId) {
      return res.status(400).json({ error: 'subaccount_id and form_id are required' });
    }

    if (!isSubmissionSizeOk(submissionData)) {
      return res.status(413).json({ error: 'Submission too large' });
    }

    const submissionId = 'fsub-' + Math.random().toString(36).slice(2, 14);
    const submittedAt = new Date().toISOString();
    let notificationSent = false;
    let contactId = null;
    let contactAction = 'none';
    let wasTokenMatch = false;

    // 1a. Signed-token attribution (intake links). ATTRIBUTION ONLY.
    //     A valid token whose subaccountId + formId match THIS submission
    //     binds the submission to the token's contactId, skipping the
    //     email/phone guess. Invalid, expired, or mismatched tokens are
    //     ignored and fall through to the cascade below. The token never
    //     creates a contact; it references one that already existed at send.
    let tokenContact = null;
    if (attributionToken) {
      try {
        const payload = await tokens.verifyToken(attributionToken);
        if (payload
            && payload.subaccountId === subaccountId
            && payload.formId === formId
            && payload.contactId) {
          const c = await getContactById(subaccountId, payload.contactId);
          if (c) tokenContact = c;
          else console.warn('intake token: contactId not found, falling back to cascade');
        } else if (payload) {
          console.warn('intake token: subaccount/form mismatch, ignoring token');
        }
      } catch (e) {
        console.warn('intake token verify failed, falling back:', e.message);
      }
    }

    // 1. Resolve contact. Token wins when present+valid; else identity cascade.
    if (tokenContact) {
      contactId = tokenContact.id;
      contactAction = 'matched';
      wasTokenMatch = true; // separate signal: how we matched (token), not what happened to the contact
      // Still fill empty contact fields from the submission, if the form allows.
      if (updateContact) {
        try {
          await updateContactFillOnly(subaccountId, tokenContact, submissionData, formName);
          contactAction = 'updated';
        } catch (e) {
          console.error('token-path fill update failed (non-fatal):', e.message);
        }
      }
    } else if (createContact || updateContact) {
      try {
        const existing = await resolveContact(subaccountId, submissionData);
        if (existing) {
          if (updateContact) {
            await updateContactFillOnly(subaccountId, existing, submissionData, formName);
            contactId = existing.id;
            contactAction = 'updated';
          } else {
            contactId = existing.id;
            contactAction = 'matched';
          }
        } else if (createContact) {
          contactId = await createContactFromSubmission(subaccountId, submissionData, formName);
          contactAction = 'created';
        } else {
          contactAction = 'skipped';
        }
      } catch (e) {
        console.error('contact resolution failed:', e.message);
        contactAction = 'error';
      }
    }

    // 2. Send notification email
    if (notifyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      try {
        const slug = String(subaccountId).replace(/^sub-/, '');
        const sendRes = await sendEmail(slug, {
          scope: 'subaccount',
          source: 'form-notification',
          to: notifyEmail,
          subject: 'New form submission: ' + formName,
          html: buildEmailHtml(formName, submissionData, pageUrl, submittedAt),
          text: buildEmailText(formName, submissionData, pageUrl, submittedAt),
          fromName: 'MySpark+ Forms'
        });
        notificationSent = !!(sendRes && sendRes.ok);
        if (!notificationSent) {
          console.error('form-notification send failed:', sendRes && sendRes.error);
        }
      } catch (e) {
        console.error('form-notification send threw:', e.message);
      }
    }

    // 3. Persist to form_submissions table (primary record). Audit log is
    //    kept as a secondary record for HIPAA/compliance reasons.
    let submissionSaved = false;
    try {
      await db.query(
        `INSERT INTO form_submissions (
          id, subaccount_id, form_id, form_name,
          contact_id, contact_action,
          submission_data, schema_version,
          page_url, ip_hash, user_agent,
          notification_sent, notification_email, notification_error,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6,
          $7, 1,
          $8, $9, $10,
          $11, $12, $13,
          NOW(), NOW()
        )`,
        [
          submissionId, subaccountId, formId, formName,
          contactId, contactAction,
          JSON.stringify(submissionData),
          pageUrl || null, hashIp(extractIp(req)), extractUserAgent(req),
          notificationSent, notifyEmail || null, null
        ]
      );
      submissionSaved = true;
    } catch (e) {
      console.error('form_submissions insert failed:', e.message);
      // A form that says "submitted" must have saved the answers. If the insert
      // failed, surface a real error instead of reporting false success. Do NOT
      // proceed to stamp intake_sends or log a successful submission.
      return res.status(500).json({ error: 'Could not save your submission. Please try again.', detail: e.message });
    }

    // 3b. Fill-tracking back-link. ONLY on the token path, where we know with
    //     certainty which intake_sends row this submission fills (the unique
    //     subaccount+contact+form triple). Stamps the send as filled. Email-
    //     cascade submissions cannot be tied to a specific send, so they don't
    //     touch intake_sends. Bookkeeping only: never fails the submission.
    if (submissionSaved && wasTokenMatch) {
      try {
        await db.update('intake_sends',
          { status: 'filled', filled_at: new Date().toISOString(), submission_id: submissionId, updated_at: new Date().toISOString() },
          { subaccount_id: subaccountId, contact_id: contactId, form_id: formId }
        );
      } catch (e) {
        console.error('intake_sends fill-stamp failed (non-fatal):', e.message);
      }
    }

    // 4. Audit log (compliance secondary record) via canonical helper.
    //    logAudit knows the real audit_log schema and never throws upward.
    await logAudit({
      req,
      actorType: 'public',
      actorId: null,
      actorUsername: 'public-form',
      action: 'subaccount.form.submit',
      targetType: 'form_submission',
      targetId: submissionId,
      targetSubaccountId: subaccountId,
      metadata: {
        form_id: formId,
        form_name: formName,
        submission_id: submissionId,
        notification_sent: notificationSent,
        notification_email: notifyEmail || null,
        contact_action: contactAction,
        contact_id: contactId,
        field_count: Object.keys(submissionData).filter(k => k !== '_hp').length
      }
    });

    // Fire automation trigger (fire-and-forget)
    try {
      if (contactId) {
        automations.fireAutomationTriggersAsync('form_submitted', {
          subaccountId,
          contactId,
          formId,
          formName,
          formSubmissionId: submissionId,
          formSubmittedAt: new Date().toISOString()
        });
      }
    } catch (autoErr) {
      console.error('Automation trigger fire error (non-fatal):', autoErr.message);
    }

    return res.status(200).json({
      ok: true,
      submission_id: submissionId,
      notification_sent: notificationSent,
      contact_id: contactId,
      contact_action: contactAction
    });
  } catch (e) {
    console.error('form-submit error:', e);
    return res.status(500).json({ error: 'Failed to process submission', detail: e.message });
  }
}
exports.handler = wrap(handler);
