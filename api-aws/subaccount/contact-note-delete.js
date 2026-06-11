// POST /api/subaccount/contact-note-delete
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { MANAGER_UP } = require('./lib/roles');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res, { requireRole: MANAGER_UP });
  if (!auth) return;
  try {
    const id = (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const r = await db.query(
      `DELETE FROM contact_notes WHERE id = $1 AND subaccount_id = $2 RETURNING id, contact_id`,
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Note not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_note.delete',
      targetType: 'contact_note', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: r.rows[0].contact_id }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-note-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete note' });
  }
}
exports.handler = wrap(handler);
