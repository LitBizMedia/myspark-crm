// GET /api/forms/submissions-list?form_id=<id>&include_archived=<bool>&limit=<n>&before=<iso>
//
// Returns form submissions for a form, scoped to the authenticated subaccount.
// Default: 50 most recent non-archived. Pagination via 'before' cursor.
// 
// HIPAA: submissions contain PHI. Every read is audit-logged.

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
  const formId = (q.form_id || '').trim();
  const includeArchived = q.include_archived === 'true' || q.include_archived === '1';
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const before = q.before ? new Date(q.before) : null;

  if (!formId) {
    return res.status(400).json({ error: 'form_id is required' });
  }

  try {
    // Build WHERE clauses dynamically; always anchor on subaccount + form
    const where = ['subaccount_id = $1', 'form_id = $2'];
    const params = [subaccountId, formId];
    let p = 3;

    if (!includeArchived) {
      where.push('archived = FALSE');
    }
    if (before && !isNaN(before.getTime())) {
      where.push(`created_at < $${p}`);
      params.push(before.toISOString());
      p++;
    }

    params.push(limit);
    const limitParam = p;

    const result = await db.query(
      `SELECT id, form_id, form_name,
              contact_id, contact_action,
              submission_data, schema_version,
              page_url, ip_hash,
              notification_sent, notification_email, notification_error,
              read_at, read_by_user_id,
              archived, archived_at, archived_by_user_id,
              replied_at, replied_by_user_id,
              created_at, updated_at
       FROM form_submissions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limitParam}`,
      params
    );

    // Count of unread for badge purposes (always run, ignores `before`)
    const unreadCount = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM form_submissions
       WHERE subaccount_id = $1 AND form_id = $2 AND read_at IS NULL AND archived = FALSE`,
      [subaccountId, formId]
    );

    const submissions = result.rows.map(r => ({
      id: r.id,
      formId: r.form_id,
      formName: r.form_name,
      contactId: r.contact_id,
      contactAction: r.contact_action,
      data: r.submission_data || {},
      schemaVersion: r.schema_version,
      pageUrl: r.page_url,
      ipHash: r.ip_hash,
      notificationSent: r.notification_sent,
      notificationEmail: r.notification_email,
      notificationError: r.notification_error,
      readAt: r.read_at instanceof Date ? r.read_at.toISOString() : r.read_at,
      readByUserId: r.read_by_user_id,
      archived: r.archived,
      archivedAt: r.archived_at instanceof Date ? r.archived_at.toISOString() : r.archived_at,
      archivedByUserId: r.archived_by_user_id,
      repliedAt: r.replied_at instanceof Date ? r.replied_at.toISOString() : r.replied_at,
      repliedByUserId: r.replied_by_user_id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    }));

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.form.submissions.list',
      targetType: 'form',
      targetId: formId,
      targetSubaccountId: subaccountId,
      metadata: {
        count: submissions.length,
        include_archived: includeArchived,
        unread_count: (unreadCount.rows[0] && unreadCount.rows[0].cnt) || 0
      }
    });

    return res.status(200).json({
      submissions,
      unread_count: (unreadCount.rows[0] && unreadCount.rows[0].cnt) || 0,
      has_more: submissions.length === limit
    });
  } catch (e) {
    console.error('form-submissions-list error:', e);
    return res.status(500).json({ error: 'Failed to load submissions', detail: e.message });
  }
}

exports.handler = wrap(handler);
