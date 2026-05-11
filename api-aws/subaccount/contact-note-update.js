// POST /api/subaccount/contact-note-update
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
    const text = b.text ? String(b.text).trim() : '';
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > 5000) return res.status(400).json({ error: 'Note exceeds 5000 character limit' });

    const r = await db.query(
      `UPDATE contact_notes SET text = $1, updated_at = NOW()
       WHERE id = $2 AND subaccount_id = $3
       RETURNING id, contact_id`,
      [text, id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Note not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_note.update',
      targetType: 'contact_note', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: r.rows[0].contact_id, char_count: text.length }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-note-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update note' });
  }
}
exports.handler = wrap(handler);
