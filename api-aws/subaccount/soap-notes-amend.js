// api/subaccount/soap-notes-amend.js (Lambda)
// POST /api/subaccount/soap-notes-amend
// Appends an amendment to a locked SOAP note. The original SOAP fields are
// never modified. Amendments are stored as a JSONB array.
//
// Permission: any subaccount user can amend (medical-record amendments
// commonly need to be addable by any authorized provider). Each amendment
// records who, when, why.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

function uid() {
  return 'amd-' + Math.random().toString(36).slice(2, 12);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const b = req.body || {};
  if (!b.note_id) return res.status(400).json({ error: 'note_id is required' });
  if (!b.content || !b.content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id, amendments FROM soap_notes WHERE id = $1 AND subaccount_id = $2',
      [b.note_id, subaccountId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'SOAP note not found' });
    }

    const amendments = existing.rows[0].amendments || [];
    // Author name is resolved on the frontend via getUserById(authorId).
    // We still cache username here as a fallback if the user is later deleted
    // and the lookup fails on the client.
    const newAmendment = {
      id: uid(),
      authorId: auth.user_id,
      authorName: auth.username || '',
      content: String(b.content).slice(0, 10000),
      reason: b.reason ? String(b.reason).slice(0, 500) : null,
      createdAt: new Date().toISOString()
    };
    amendments.push(newAmendment);

    await db.query(
      'UPDATE soap_notes SET amendments = $1::jsonb, updated_at = NOW() WHERE id = $2 AND subaccount_id = $3',
      [JSON.stringify(amendments), b.note_id, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.soap_note.amend',
      targetType: 'soap_note',
      targetId: b.note_id,
      targetSubaccountId: subaccountId,
      metadata: {
        amendment_id: newAmendment.id,
        has_reason: !!b.reason
      }
    });

    return res.status(200).json({ success: true, amendment: newAmendment });
  } catch (e) {
    console.error('soap-notes-amend error:', e.message);
    return res.status(500).json({ error: 'Failed to add amendment' });
  }
}

exports.handler = wrap(handler);
