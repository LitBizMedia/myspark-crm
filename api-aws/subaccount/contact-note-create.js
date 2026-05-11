// POST /api/subaccount/contact-note-create
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

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
    if (!contactId) return res.status(400).json({ error: 'contact_id is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > 5000) return res.status(400).json({ error: 'Note exceeds 5000 character limit' });

    const c = await db.query(
      `SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2`,
      [contactId, auth.subaccount_id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const id = uid();
    const authorName = auth.display_name || auth.username || null;

    await db.query(
      `INSERT INTO contact_notes (id, contact_id, subaccount_id, text, author_id, author_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [id, contactId, auth.subaccount_id, text, auth.user_id, authorName]
    );

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_note.create',
      targetType: 'contact_note', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: contactId, char_count: text.length }
    });

    return res.status(200).json({
      success: true,
      id,
      note: {
        id, contact_id: contactId, text,
        author_id: auth.user_id, author_name: authorName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('contact-note-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create note' });
  }
}
exports.handler = wrap(handler);
