// GET /api/forms/submission-counts
//
// Returns submission counts grouped by form_id for the authenticated subaccount.
// Single query for all forms, faster than N round-trips when the forms list
// renders. Bulk endpoint, audit-logged at aggregate level only.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    // Single query: total + unread, grouped by form_id, excluding archived.
    const result = await db.query(
      `SELECT form_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
       FROM form_submissions
       WHERE subaccount_id = $1 AND archived = FALSE
       GROUP BY form_id`,
      [subaccountId]
    );

    const counts = {};
    let totalSubmissions = 0;
    let totalUnread = 0;
    result.rows.forEach(r => {
      counts[r.form_id] = { total: r.total, unread: r.unread };
      totalSubmissions += r.total;
      totalUnread += r.unread;
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.form.submissions.counts',
      targetType: 'form',
      targetId: null,
      targetSubaccountId: subaccountId,
      metadata: {
        forms_with_submissions: result.rows.length,
        total_submissions: totalSubmissions,
        total_unread: totalUnread
      }
    });

    return res.status(200).json({ counts });
  } catch (e) {
    console.error('form-submission-counts error:', e);
    return res.status(500).json({ error: 'Failed to load submission counts', detail: e.message });
  }
}

exports.handler = wrap(handler);
