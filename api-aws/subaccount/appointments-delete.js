// api/subaccount/appointments-delete.js (Lambda version)
// POST /api/subaccount/appointments-delete
// Deletes a single appointment for the authenticated subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      'DELETE FROM appointments WHERE id = $1 AND subaccount_id = $2 RETURNING id',
      [id, subaccountId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.appointment.delete',
      targetType: 'appointment',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {}
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('appointments-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete appointment' });
  }
}

exports.handler = wrap(handler);
