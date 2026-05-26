// api/subaccount/appointments-hard-delete.js (Lambda)
// POST /api/subaccount/appointments-hard-delete
//
// PERMANENT removal. Use cases: test data cleanup, GDPR right-to-erasure,
// mistaken bookings made before any patient contact. For normal cancellation,
// use appointments-delete.js (soft-cancel).
//
// HIPAA caveat: this should be used sparingly. Audit log entry persists
// (audit_log has 6-year retention) so the action itself is recorded even
// after the appointment row is gone.
//
// Body: { id, reason? }
// Response: { success, id }

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Capture appointment data BEFORE the delete for the audit log
    const before = await db.query(
      `SELECT id, title, date, time, status, contact_id, assigned_to
         FROM appointments
        WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );
    if (before.rowCount === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const appt = before.rows[0];

    // Hard DELETE. Cascade FKs on appointment_clients, appointment_staff,
    // appointment_resources will clean those up. Payment records linked
    // via appointment_id have ON DELETE SET NULL so they remain.
    const del = await db.query(
      `DELETE FROM appointments WHERE id = $1 AND subaccount_id = $2 RETURNING id`,
      [id, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.appointment.hard_delete',
      targetType: 'appointment',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {
        previous_status: appt.status,
        title: appt.title,
        date: appt.date,
        contact_id: appt.contact_id,
        reason: reason ? String(reason).slice(0, 500) : null
      }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('appointments-hard-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to permanently delete appointment' });
  }
}

exports.handler = wrap(handler);
