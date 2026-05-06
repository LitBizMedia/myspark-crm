// api/subaccount/soap-notes-update.js (Lambda)
// PUT /api/subaccount/soap-notes-update
// Updates an existing SOAP note. Blocked if the note is locked. Permission:
// only the original author or an admin/manager can edit.

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
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const n = req.body || {};
  if (!n.id) return res.status(400).json({ error: 'id is required' });

  const subaccountId = auth.subaccount_id;
  const userId = auth.user_id;
  const isAdminish = auth.role === 'admin' || auth.role === 'manager';

  try {
    const existing = await db.query(
      'SELECT * FROM soap_notes WHERE id = $1 AND subaccount_id = $2',
      [n.id, subaccountId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'SOAP note not found' });
    }

    const row = existing.rows[0];

    // Permission: author or admin/manager only
    if (row.author_id !== userId && !isAdminish) {
      return res.status(403).json({ error: 'Only the author or an admin can edit this note' });
    }

    // Lock check: if locked, block edits. Use amendments endpoint instead.
    if (isLocked(row)) {
      return res.status(409).json({
        error: 'This note is locked and cannot be edited. Use amendments instead.',
        locked: true
      });
    }

    // Validate appointment_id if changed and present
    if (n.appointmentId) {
      const appt = await db.query(
        'SELECT id FROM appointments WHERE id = $1 AND subaccount_id = $2',
        [n.appointmentId, subaccountId]
      );
      if (appt.rows.length === 0) {
        return res.status(400).json({ error: 'appointmentId not found in this subaccount' });
      }
    }

    // signed flag triggers immediate lock by setting signed_at
    const signedAt = n.signed ? new Date().toISOString() : (row.signed_at || null);
    const vitals = (n.vitals && typeof n.vitals === 'object') ? n.vitals : {};

    await db.query(`
      UPDATE soap_notes SET
        appointment_id = $1,
        subjective = $2,
        objective = $3,
        assessment = $4,
        plan = $5,
        vitals = $6::jsonb,
        visit_date = $7,
        template_used = $8,
        signed_at = $9,
        updated_at = NOW()
      WHERE id = $10 AND subaccount_id = $11
    `, [
      n.appointmentId || null,
      n.subjective || '', n.objective || '', n.assessment || '', n.plan || '',
      JSON.stringify(vitals),
      n.visitDate || null, n.templateUsed || null, signedAt,
      n.id, subaccountId
    ]);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: userId,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.soap_note.update',
      targetType: 'soap_note',
      targetId: n.id,
      targetSubaccountId: subaccountId,
      metadata: {
        contact_id: row.contact_id,
        signed_now: !!n.signed && !row.signed_at
      }
    });

    return res.status(200).json({ success: true, id: n.id });
  } catch (e) {
    console.error('soap-notes-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update SOAP note' });
  }
}

exports.handler = wrap(handler);
