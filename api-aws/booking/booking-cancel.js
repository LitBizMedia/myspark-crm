// PUBLIC - no auth required, validates via opaque token
//
// POST /api/booking/cancel-appointment
//
// Cancels an appointment via a signed token from the confirmation email.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const token = (body.token || '').toString().trim();
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const tokRes = await db.query(
      `SELECT token, appointment_id, subaccount_id, action, expires_at, used_at
         FROM booking_action_tokens WHERE token = $1`,
      [token]
    );
    if (tokRes.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired link.' });
    const tok = tokRes.rows[0];

    if (tok.action !== 'cancel') return res.status(400).json({ error: 'This link is not for cancellation.' });
    if (tok.used_at) return res.status(400).json({ error: 'This cancellation link was already used.' });
    if (new Date(tok.expires_at) < new Date()) return res.status(400).json({ error: 'This cancellation link has expired.' });

    const apptRes = await db.query(
      `SELECT id, title, date, time, status, contact_id
         FROM appointments WHERE id = $1 AND subaccount_id = $2`,
      [tok.appointment_id, tok.subaccount_id]
    );
    if (apptRes.rows.length === 0) return res.status(404).json({ error: 'Appointment not found.' });
    const appt = apptRes.rows[0];
    if (appt.status === 'cancelled') return res.status(400).json({ error: 'This appointment is already cancelled.' });

    await db.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [appt.id]
    );
    await db.query(
      `UPDATE booking_action_tokens SET used_at = NOW() WHERE token = $1`,
      [token]
    );

    try {
      await logAudit({
        subaccountId: tok.subaccount_id,
        action: 'booking.appointment.cancel',
        actorType: 'public',
        actorId: appt.contact_id || null,
        targetType: 'appointment',
        targetId: appt.id,
        metadata: { via: 'self_serve_link' }
      });
    } catch (e) { /* swallow */ }

    return res.status(200).json({
      success: true,
      appointment_id: appt.id,
      title: appt.title,
      date: appt.date instanceof Date ? appt.date.toISOString().slice(0,10) : appt.date,
      time: appt.time
    });
  } catch (e) {
    console.error('booking-cancel error:', e);
    return res.status(500).json({ error: 'Server error. Please try again or contact us.' });
  }
}

exports.handler = wrap(handler);
