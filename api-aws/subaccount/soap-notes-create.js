// api/subaccount/soap-notes-create.js (Lambda)
// POST /api/subaccount/soap-notes-create
// Creates a new SOAP note for a contact. Optionally linked to an appointment.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const n = req.body || {};
  if (!n.id) return res.status(400).json({ error: 'id is required' });
  if (!n.contactId) return res.status(400).json({ error: 'contactId is required' });

  const subaccountId = auth.subaccount_id;

  // If linked to an appointment, validate it belongs to the same subaccount.
  // Cross-tenant linking would be a security boundary violation.
  if (n.appointmentId) {
    const appt = await db.query(
      'SELECT id FROM appointments WHERE id = $1 AND subaccount_id = $2',
      [n.appointmentId, subaccountId]
    );
    if (appt.rows.length === 0) {
      return res.status(400).json({ error: 'appointmentId not found in this subaccount' });
    }
  }

  // signed flag from frontend means "lock immediately"; we set signed_at.
  const signedAt = n.signed ? new Date().toISOString() : null;

  // Vitals are an arbitrary JSON object. Frontend validates the shape; we
  // store as-is with a default of {} for notes that have no vitals.
  const vitals = (n.vitals && typeof n.vitals === 'object') ? n.vitals : {};

  try {
    await db.query(`
      INSERT INTO soap_notes (
        id, subaccount_id, contact_id, appointment_id, author_id,
        subjective, objective, assessment, plan, vitals,
        visit_date, template_used, signed_at,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, NOW(), NOW())
    `, [
      n.id, subaccountId, n.contactId, n.appointmentId || null, auth.user_id,
      n.subjective || '', n.objective || '', n.assessment || '', n.plan || '',
      JSON.stringify(vitals),
      n.visitDate || null, n.templateUsed || null, signedAt
    ]);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.soap_note.create',
      targetType: 'soap_note',
      targetId: n.id,
      targetSubaccountId: subaccountId,
      metadata: {
        contact_id: n.contactId,
        appointment_id: n.appointmentId || null,
        signed: !!signedAt,
        template: n.templateUsed || null
      }
    });

    return res.status(200).json({ success: true, id: n.id });
  } catch (e) {
    console.error('soap-notes-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create SOAP note' });
  }
}

exports.handler = wrap(handler);
