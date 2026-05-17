// POST /api/forms/submissions-mark-read
// Body: { submission_id }  OR  { form_id }
//
// submission_id: marks that one submission as read
// form_id: marks ALL unread submissions for that form as read (legacy bulk)
// Returns { marked: <count> }. Idempotent.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const submissionId = (body.submission_id || '').trim();
  const formId = (body.form_id || '').trim();

  if (!submissionId && !formId) {
    return res.status(400).json({ error: 'submission_id or form_id is required' });
  }

  try {
    let result, action, targetType, targetId, metadata;

    if (submissionId) {
      result = await db.query(
        `UPDATE form_submissions
         SET read_at = NOW(),
             read_by_user_id = $3,
             updated_at = NOW()
         WHERE subaccount_id = $1
           AND id = $2
           AND read_at IS NULL
         RETURNING id, form_id`,
        [subaccountId, submissionId, auth.user_id]
      );
      action = 'subaccount.form.submission.mark_read';
      targetType = 'form_submission';
      targetId = submissionId;
      metadata = {
        marked_count: result.rowCount || 0,
        form_id: result.rows[0] ? result.rows[0].form_id : null
      };
    } else {
      result = await db.query(
        `UPDATE form_submissions
         SET read_at = NOW(),
             read_by_user_id = $3,
             updated_at = NOW()
         WHERE subaccount_id = $1
           AND form_id = $2
           AND read_at IS NULL
           AND archived = FALSE
         RETURNING id`,
        [subaccountId, formId, auth.user_id]
      );
      action = 'subaccount.form.submissions.mark_read_bulk';
      targetType = 'form';
      targetId = formId;
      metadata = { marked_count: result.rowCount || 0 };
    }

    const marked = result.rowCount || 0;

    if (marked > 0) {
      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: action,
        targetType: targetType,
        targetId: targetId,
        targetSubaccountId: subaccountId,
        metadata: metadata
      });
    }

    return res.status(200).json({ marked });
  } catch (e) {
    console.error('form-submissions-mark-read error:', e);
    return res.status(500).json({ error: 'Failed to mark submissions read', detail: e.message });
  }
}

exports.handler = wrap(handler);
