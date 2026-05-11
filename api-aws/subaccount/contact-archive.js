// POST /api/subaccount/contact-archive
// Soft-deletes a contact (sets archived = true). Reversible.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const id = b.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const unarchive = b.unarchive === true;

    const r = await db.query(
      `UPDATE contacts SET archived = $3, updated_at = NOW(), updated_by = $4
       WHERE id = $1 AND subaccount_id = $2
       RETURNING id, display_name, archived`,
      [id, auth.subaccount_id, !unarchive, auth.user_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contact not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: unarchive ? 'subaccount.contact.unarchive' : 'subaccount.contact.archive',
      targetType: 'contact', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { display_name: r.rows[0].display_name }
    });

    return res.status(200).json({ success: true, id, archived: r.rows[0].archived });
  } catch (e) {
    console.error('contact-archive error:', e.message);
    return res.status(500).json({ error: 'Failed to archive contact' });
  }
}
exports.handler = wrap(handler);
