// POST /api/forms/submission-delete
// Body: { submission_id }
//
// Deletes a single form submission, tenant-isolated. Before deleting, it
// severs any intake_sends link: a filled intake send points at this submission
// via submission_id, so we revert that send row to 'sent' (clear submission_id
// and filled_at) rather than leave a row claiming 'filled' with a dangling
// reference. The send genuinely happened; only the fill is being removed.

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
  if (!submissionId) {
    return res.status(400).json({ error: 'submission_id is required' });
  }

  try {
    // Sever any intake_sends link first (revert filled -> sent). Tenant-scoped.
    const reverted = await db.query(
      `UPDATE intake_sends
       SET submission_id = NULL,
           filled_at = NULL,
           status = CASE WHEN status = 'filled' THEN 'sent' ELSE status END,
           updated_at = NOW()
       WHERE subaccount_id = $1 AND submission_id = $2
       RETURNING id`,
      [subaccountId, submissionId]
    );

    // Delete the submission, tenant-isolated.
    const del = await db.query(
      `DELETE FROM form_submissions
       WHERE subaccount_id = $1 AND id = $2
       RETURNING id, form_id`,
      [subaccountId, submissionId]
    );

    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.form.submission.delete',
      targetType: 'form_submission',
      targetId: submissionId,
      targetSubaccountId: subaccountId,
      metadata: {
        form_id: del.rows[0].form_id,
        intake_sends_reverted: reverted.rows.length
      }
    });

    return res.status(200).json({
      success: true,
      deleted: submissionId,
      intake_sends_reverted: reverted.rows.length
    });
  } catch (e) {
    console.error('form-submission-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete submission' });
  }
}

exports.handler = wrap(handler);
