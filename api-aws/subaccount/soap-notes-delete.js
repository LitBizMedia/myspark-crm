// api/subaccount/soap-notes-delete.js (Lambda)
// DELETE /api/subaccount/soap-notes-delete
// Hard-deletes a SOAP note. Permission: author OR admin/manager.
//
// NOTE on medical records: industry standard is to NOT delete signed/locked
// notes. We allow admin override here for cases like "wrong patient" mistakes.
// Every delete is heavily audit-logged with the full content snapshot for
// reconstruction if ever needed.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const LOCK_HOURS = 24;

function isLocked(row) {
  if (row.signed_at) return true;
  const created = new Date(row.created_at).getTime();
  return Date.now() - created > LOCK_HOURS * 60 * 60 * 1000;
}

async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const b = req.body || {};
  const id = b.id || (req.query && req.query.id);
  if (!id) return res.status(400).json({ error: 'id is required' });

  const subaccountId = auth.subaccount_id;
  const userId = auth.user_id;
  const isAdminish = auth.role === 'admin' || auth.role === 'manager';

  try {
    const existing = await db.query(
      'SELECT * FROM soap_notes WHERE id = $1 AND subaccount_id = $2',
      [id, subaccountId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'SOAP note not found' });
    }

    const row = existing.rows[0];

    // Author can delete unlocked notes; admin/manager can delete any.
    if (row.author_id !== userId && !isAdminish) {
      return res.status(403).json({ error: 'Only the author or an admin can delete this note' });
    }
    if (isLocked(row) && !isAdminish) {
      return res.status(403).json({
        error: 'This note is locked. Only an admin can delete a locked note.'
      });
    }

    await db.query('DELETE FROM soap_notes WHERE id = $1 AND subaccount_id = $2', [id, subaccountId]);

    // Heavy audit: snapshot the content so the deletion is reconstructable.
    // PHI is included intentionally because medical-record deletion needs
    // a recoverable trail.
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: userId,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.soap_note.delete',
      targetType: 'soap_note',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {
        contact_id: row.contact_id,
        appointment_id: row.appointment_id,
        was_signed: !!row.signed_at,
        was_locked: isLocked(row),
        snapshot: {
          subjective: row.subjective,
          objective: row.objective,
          assessment: row.assessment,
          plan: row.plan,
          visit_date: row.visit_date,
          created_at: row.created_at,
          author_id: row.author_id
        }
      }
    });

    return res.status(200).json({ success: true, id: id });
  } catch (e) {
    console.error('soap-notes-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete SOAP note' });
  }
}

exports.handler = wrap(handler);
