// api/subaccount/email-templates-upsert.js (Lambda version)
// POST /api/subaccount/email-templates-upsert
// Creates or updates an email template.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const t = req.body || {};
  if (!t.template_type) return res.status(400).json({ error: 'template_type required' });
  if (!t.name) return res.status(400).json({ error: 'name required' });
  if (!t.subject) return res.status(400).json({ error: 'subject required' });
  if (!t.body_html) return res.status(400).json({ error: 'body_html required' });

  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(`
      INSERT INTO email_templates (subaccount_id, template_type, name, subject, body_html, body_text, is_default, enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (subaccount_id, template_type) DO UPDATE SET
        name = EXCLUDED.name,
        subject = EXCLUDED.subject,
        body_html = EXCLUDED.body_html,
        body_text = EXCLUDED.body_text,
        is_default = EXCLUDED.is_default,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
      RETURNING *
    `, [
      subaccountId, t.template_type, t.name, t.subject, t.body_html,
      t.body_text || null, t.is_default || false, t.enabled !== false
    ]);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_template.upsert',
      targetType: 'email_template',
      targetId: t.template_type,
      targetSubaccountId: subaccountId,
      metadata: { name: t.name, enabled: t.enabled !== false }
    });

    return res.status(200).json({ template: r.rows[0] });
  } catch (e) {
    console.error('email-templates-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save template' });
  }
}

exports.handler = wrap(handler);
