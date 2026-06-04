// lib-aws/contracts.js
// Canonical RDS accessor for contract_templates and contract_envelopes.
// See docs/MySpark-Contracts-Spec.md
//
// Never query these tables directly from a Lambda. Always go through this module.
// Multi-tenant isolation: every read/write requires subaccount_id.

const db = require('./db');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function genId(prefix) {
  // 12-char shortid pattern: prefix + base36 timestamp + random
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}${rnd}`.slice(0, 24);
}

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// Row -> frontend camelCase mapper for templates
function templateToFrontend(r) {
  if (!r) return null;
  return {
    id: r.id,
    subaccountId: r.subaccount_id,
    name: r.name,
    description: r.description,
    active: r.active,
    bodyHtml: r.body_html,
    bodyPlaintext: r.body_plaintext,
    defaultExpirationDays: r.default_expiration_days,
    requireEmailVerification: r.require_email_verification === true,
    defaultSignatureRequired: r.default_signature_required,
    defaultAgreeText: r.default_agree_text,
    sendCount: r.send_count,
    signCount: r.sign_count,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// Row -> frontend camelCase mapper for envelopes
function envelopeToFrontend(r) {
  if (!r) return null;
  return {
    id: r.id,
    subaccountId: r.subaccount_id,
    templateId: r.template_id,
    contactId: r.contact_id,
    recipientName: r.recipient_name,
    recipientEmail: r.recipient_email,
    senderId: r.sender_id,
    senderName: r.sender_name,
    title: r.title,
    bodyHtml: r.body_html,
    variablesSnapshot: r.variables_snapshot,
    agreeText: r.agree_text,
    status: r.status,
    expiresAt: r.expires_at,
    requireEmailVerification: r.require_email_verification === true,
    sentAt: r.sent_at,
    firstViewedAt: r.first_viewed_at,
    lastViewedAt: r.last_viewed_at,
    viewCount: r.view_count,
    emailVerifiedAt: r.email_verified_at,
    signedAt: r.signed_at,
    signedTypedName: r.signed_typed_name,
    signedIp: r.signed_ip,
    signedUserAgent: r.signed_user_agent,
    signedPdfS3Key: r.signed_pdf_s3_key,
    signedPdfSha256: r.signed_pdf_sha256,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    voidReason: r.void_reason,
    appointmentId: r.appointment_id,
    lastReminderSentAt: r.last_reminder_sent_at,
    reminderCount: r.reminder_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// ============================================================================
// TEMPLATE OPERATIONS
// ============================================================================

async function listTemplates(subaccountId, { activeOnly = true } = {}) {
  if (!subaccountId) throw new Error('subaccountId required');
  const params = [subaccountId];
  let where = 'subaccount_id = $1';
  if (activeOnly) where += ' AND active = TRUE';
  const r = await db.query(
    `SELECT * FROM contract_templates
       WHERE ${where}
       ORDER BY updated_at DESC`,
    params
  );
  return r.rows.map(templateToFrontend);
}

async function getTemplate(subaccountId, id) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');
  const r = await db.query(
    `SELECT * FROM contract_templates
       WHERE subaccount_id = $1 AND id = $2
       LIMIT 1`,
    [subaccountId, id]
  );
  return templateToFrontend(r.rows[0]);
}

async function createTemplate(subaccountId, createdBy, data) {
  if (!subaccountId) throw new Error('subaccountId required');
  if (!data || !data.name || !data.bodyHtml) {
    throw new Error('name and bodyHtml required');
  }
  const id = genId('ctmpl');
  const r = await db.query(
    `INSERT INTO contract_templates (
       id, subaccount_id, name, description, active,
       body_html, body_plaintext,
       default_expiration_days, default_signature_required, default_agree_text, require_email_verification,
       created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      id,
      subaccountId,
      data.name,
      data.description || null,
      data.active !== false,
      data.bodyHtml,
      data.bodyPlaintext || null,
      Number.isInteger(data.defaultExpirationDays) ? data.defaultExpirationDays : 30,
      data.defaultSignatureRequired !== false,
      data.defaultAgreeText || 'I agree to electronically sign this document and confirm that the information provided is accurate.',
      createdBy || null
    ]
  );
  return templateToFrontend(r.rows[0]);
}

async function updateTemplate(subaccountId, id, data) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');

  // Whitelist of mutable fields
  const allowed = {
    name: data.name,
    description: data.description,
    active: data.active,
    body_html: data.bodyHtml,
    body_plaintext: data.bodyPlaintext,
    default_expiration_days: data.defaultExpirationDays,
    require_email_verification: data.requireEmailVerification === true,
    default_signature_required: data.defaultSignatureRequired,
    default_agree_text: data.defaultAgreeText
  };
  const clean = stripUndefined(allowed);
  const keys = Object.keys(clean);
  if (keys.length === 0) return getTemplate(subaccountId, id);

  const setClauses = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const values = [subaccountId, id, ...keys.map(k => clean[k])];

  const r = await db.query(
    `UPDATE contract_templates
       SET ${setClauses}
       WHERE subaccount_id = $1 AND id = $2
       RETURNING *`,
    values
  );
  return templateToFrontend(r.rows[0]);
}

async function deleteTemplate(subaccountId, id) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');

  // Soft delete: set active=false. Preserves history and any envelope FK references.
  const r = await db.query(
    `UPDATE contract_templates
       SET active = FALSE
       WHERE subaccount_id = $1 AND id = $2
       RETURNING id`,
    [subaccountId, id]
  );
  return { deleted: r.rowCount > 0, id };
}

async function incrementTemplateCount(subaccountId, id, field) {
  // field: 'send_count' or 'sign_count'
  if (!['send_count', 'sign_count'].includes(field)) {
    throw new Error('invalid field');
  }
  await db.query(
    `UPDATE contract_templates
       SET ${field} = ${field} + 1
       WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, id]
  );
}

// ============================================================================
// ENVELOPE OPERATIONS
// ============================================================================

async function listEnvelopes(subaccountId, { status, contactId, limit = 100, offset = 0, includeArchived = false } = {}) {
  if (!subaccountId) throw new Error('subaccountId required');
  const params = [subaccountId];
  let where = 'subaccount_id = $1';
  if (!includeArchived) {
    where += ' AND archived = false';
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (contactId) {
    params.push(contactId);
    where += ` AND contact_id = $${params.length}`;
  }
  params.push(limit, offset);
  const r = await db.query(
    `SELECT * FROM contract_envelopes
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows.map(envelopeToFrontend);
}

async function getEnvelope(subaccountId, id) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');
  const r = await db.query(
    `SELECT * FROM contract_envelopes
       WHERE subaccount_id = $1 AND id = $2
       LIMIT 1`,
    [subaccountId, id]
  );
  return envelopeToFrontend(r.rows[0]);
}

// Used by public signing endpoints. Joins via token_hash, not by envelope_id alone.
async function getEnvelopeByTokenHash(envelopeId, tokenHash) {
  if (!envelopeId || !tokenHash) throw new Error('envelopeId and tokenHash required');
  const r = await db.query(
    `SELECT * FROM contract_envelopes
       WHERE id = $1 AND token_hash = $2
       LIMIT 1`,
    [envelopeId, tokenHash]
  );
  return envelopeToFrontend(r.rows[0]);
}

// Counts envelopes per status for the current subaccount.
// Returns { sent, viewed, signed, expired, voided, draft }.
async function getEnvelopeStatusCounts(subaccountId, { includeArchived = false } = {}) {
  if (!subaccountId) throw new Error('subaccountId required');
  const archFilter = includeArchived ? '' : ' AND archived = false';
  const r = await db.query(
    `SELECT status, COUNT(*)::int AS n
       FROM contract_envelopes
       WHERE subaccount_id = $1` + archFilter + `
       GROUP BY status`,
    [subaccountId]
  );
  const counts = { draft: 0, sent: 0, viewed: 0, signed: 0, expired: 0, voided: 0 };
  for (const row of r.rows) {
    counts[row.status] = row.n;
  }
  return counts;
}

// Void an envelope. Returns the updated row or null if not found.
// Only allowed when status is draft, sent, or viewed. Signed envelopes
// cannot be voided (they are legal records).
async function voidEnvelope(subaccountId, id, voidedBy, voidReason) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');
  const r = await db.query(
    `UPDATE contract_envelopes
       SET status = 'voided',
           voided_at = NOW(),
           voided_by = $1,
           void_reason = $2
       WHERE subaccount_id = $3
         AND id = $4
         AND status IN ('draft', 'sent', 'viewed')
       RETURNING *`,
    [voidedBy || null, (voidReason || '').slice(0, 500) || null, subaccountId, id]
  );
  return envelopeToFrontend(r.rows[0]);
}

// Archive an envelope: hides it from the default view but preserves it as a
// legal record. Unlike void, archive is allowed from ANY status (you archive
// completed/voided/expired contracts to tidy the list). Sets archived=true.
async function archiveEnvelope(subaccountId, id, archivedBy) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');
  const r = await db.query(
    `UPDATE contract_envelopes
       SET archived = true,
           archived_at = NOW()
       WHERE subaccount_id = $1
         AND id = $2
       RETURNING *`,
    [subaccountId, id]
  );
  return r.rows.length ? envelopeToFrontend(r.rows[0]) : null;
}

// Unarchive: restore an envelope to the default view.
async function unarchiveEnvelope(subaccountId, id) {
  if (!subaccountId || !id) throw new Error('subaccountId and id required');
  const r = await db.query(
    `UPDATE contract_envelopes
       SET archived = false,
           archived_at = NULL
       WHERE subaccount_id = $1
         AND id = $2
       RETURNING *`,
    [subaccountId, id]
  );
  return r.rows.length ? envelopeToFrontend(r.rows[0]) : null;
}

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  // Templates
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  incrementTemplateCount,

  // Envelopes
  listEnvelopes,
  getEnvelope,
  getEnvelopeByTokenHash,
  getEnvelopeStatusCounts,
  voidEnvelope,
  archiveEnvelope,
  unarchiveEnvelope,

  // Mappers (exported for any future cross-module reuse)
  templateToFrontend,
  envelopeToFrontend,

  // ID generator (exported for Lambdas creating envelopes)
  genId
};
