// api/subaccount/email-templates-delete.js (Lambda version)
// POST /api/subaccount/email-templates-delete
// Deletes an email template (resets to default).

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const { template_type } = req.body || {};
  if (!template_type) return res.status(400).json({ error: 'template_type required' });

  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      'DELETE FROM email_templates WHERE subaccount_id = $1 AND template_type = $2 RETURNING id',
      [subaccountId, template_type]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_template.delete',
      targetType: 'email_template',
      targetId: template_type,
      targetSubaccountId: subaccountId,
      metadata: {}
    });

    return res.status(200).json({ success: true, deleted: r.rowCount });
  } catch (e) {
    console.error('email-templates-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete template' });
  }
}

exports.handler = wrap(handler);
