// POST /api/subaccount/contact-warning-create
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_SEVERITY = ['info', 'warning', 'critical'];

function uid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const contactId = b.contact_id;
    const text = b.text ? String(b.text).trim() : '';
    const severity = b.severity;

    if (!contactId) return res.status(400).json({ error: 'contact_id is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > 200) return res.status(400).json({ error: 'Warning exceeds 200 character limit' });
    if (!ALLOWED_SEVERITY.includes(severity)) {
      return res.status(400).json({ error: 'severity must be one of info, warning, critical' });
    }

    const c = await db.query(
      `SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2`,
      [contactId, auth.subaccount_id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const id = uid();
    await db.query(
      `INSERT INTO contact_warnings (id, contact_id, subaccount_id, severity, text, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW(), $6)`,
      [id, contactId, auth.subaccount_id, severity, text, auth.user_id]
    );

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_warning.create',
      targetType: 'contact_warning', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: contactId, severity }
    });

    return res.status(200).json({
      success: true,
      id,
      warning: {
        id, contact_id: contactId, severity, text,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('contact-warning-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create warning' });
  }
}
exports.handler = wrap(handler);
