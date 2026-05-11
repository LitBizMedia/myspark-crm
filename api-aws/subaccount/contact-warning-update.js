// POST /api/subaccount/contact-warning-update
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_SEVERITY = ['info', 'warning', 'critical'];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const id = b.id;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const sets = [];
    const params = [id, auth.subaccount_id];
    let p = 3;

    if ('text' in b) {
      const text = b.text ? String(b.text).trim() : '';
      if (!text) return res.status(400).json({ error: 'text cannot be empty' });
      if (text.length > 200) return res.status(400).json({ error: 'Warning exceeds 200 character limit' });
      sets.push(`text = $${p++}`);
      params.push(text);
    }
    if ('severity' in b) {
      if (!ALLOWED_SEVERITY.includes(b.severity)) {
        return res.status(400).json({ error: 'severity must be one of info, warning, critical' });
      }
      sets.push(`severity = $${p++}`);
      params.push(b.severity);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    sets.push(`updated_at = NOW()`);
    sets.push(`updated_by = $${p}`);
    params.push(auth.user_id);

    const r = await db.query(
      `UPDATE contact_warnings SET ${sets.join(', ')} WHERE id = $1 AND subaccount_id = $2 RETURNING id, contact_id, severity`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Warning not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_warning.update',
      targetType: 'contact_warning', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: r.rows[0].contact_id, severity: r.rows[0].severity }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-warning-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update warning' });
  }
}
exports.handler = wrap(handler);
