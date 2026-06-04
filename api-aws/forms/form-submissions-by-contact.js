// GET /api/forms/submissions-by-contact?contact_id=<id>&include_archived=<bool>&limit=<n>
//
// Returns all form submissions for one contact, scoped to the authenticated
// subaccount. Powers the contact drawer's Forms tab. Default: 50 most recent
// non-archived, newest first.
//
// HIPAA: submissions contain PHI. Every read is audit-logged as a
// contact-scoped read (target = the contact).

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const q = req.query || {};
  const contactId = (q.contact_id || '').trim();
  const includeArchived = q.include_archived === 'true' || q.include_archived === '1';
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);

  if (!contactId) {
    return res.status(400).json({ error: 'contact_id is required' });
  }

  try {
    // Always anchor on subaccount + contact. Tenant isolation: subaccountId
    // comes from the auth session, never the request.
    const where = ['subaccount_id = $1', 'contact_id = $2'];
    const params = [subaccountId, contactId];
    let p = 3;

    if (!includeArchived) {
      where.push('archived = FALSE');
    }

    params.push(limit);
    const limitParam = p;

    const result = await db.query(
      `SELECT id, form_id, form_name,
              contact_id, contact_action,
              submission_data, schema_version,
              read_at, archived, archived_at,
              created_at, updated_at
       FROM form_submissions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limitParam}`,
      params
    );

    const submissions = result.rows.map(r => ({
      id: r.id,
      formId: r.form_id,
      formName: r.form_name,
      contactId: r.contact_id,
      contactAction: r.contact_action,
      data: r.submission_data || {},
      schemaVersion: r.schema_version,
      readAt: r.read_at instanceof Date ? r.read_at.toISOString() : r.read_at,
      archived: r.archived,
      archivedAt: r.archived_at instanceof Date ? r.archived_at.toISOString() : r.archived_at,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    }));

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.form.submissions.by_contact',
      targetType: 'contact',
      targetId: contactId,
      targetSubaccountId: subaccountId,
      metadata: { count: submissions.length, include_archived: includeArchived }
    });

    return res.status(200).json({
      submissions,
      has_more: submissions.length === limit
    });
  } catch (e) {
    console.error('form-submissions-by-contact error:', e);
    return res.status(500).json({ error: 'Failed to load submissions', detail: e.message });
  }
}

exports.handler = wrap(handler);
