// PUBLIC - no auth required, validates via opaque token
//
// POST /api/booking/cancel-appointment
//
// Cancels an appointment via a signed token from the confirmation email.
// Token is validated, appointment is set to status='cancelled', token is marked used.
//
// Request: { "token": "..." }
// Response: { "success": true, "appointment_id": "...", "title": "...", "date": "...", "time": "..." }
//           or { "error": "..." } with 4xx status

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  const cors = {
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  };
  if (req.method === 'OPTIONS') return res.status(204).set(cors).send('');
  if (req.method !== 'POST') return res.status(405).set(cors).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const token = (body.token || '').toString().trim();
  if (!token) return res.status(400).set(cors).json({ error: 'Missing token' });

  try {
    // Look up the token
    const tokRes = await db.query(
      `SELECT token, appointment_id, subaccount_id, action, expires_at, used_at
         FROM booking_action_tokens
        WHERE token = $1`,
      [token]
    );
    if (tokRes.rows.length === 0) {
      return res.status(404).set(cors).json({ error: 'Invalid or expired link.' });
    }
    const tok = tokRes.rows[0];

    if (tok.action !== 'cancel') {
      return res.status(400).set(cors).json({ error: 'This link is not for cancellation.' });
    }
    if (tok.used_at) {
      return res.status(400).set(cors).json({ error: 'This cancellation link was already used.' });
    }
    if (new Date(tok.expires_at) < new Date()) {
      return res.status(400).set(cors).json({ error: 'This cancellation link has expired.' });
    }

    // Look up the appointment
    const apptRes = await db.query(
      `SELECT id, title, date, time, status, contact_id
         FROM appointments
        WHERE id = $1 AND subaccount_id = $2`,
      [tok.appointment_id, tok.subaccount_id]
    );
    if (apptRes.rows.length === 0) {
      return res.status(404).set(cors).json({ error: 'Appointment not found.' });
    }
    const appt = apptRes.rows[0];
    if (appt.status === 'cancelled') {
      return res.status(400).set(cors).json({ error: 'This appointment is already cancelled.' });
    }

    // Perform cancellation
    await db.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [appt.id]
    );
    await db.query(
      `UPDATE booking_action_tokens SET used_at = NOW() WHERE token = $1`,
      [token]
    );

    // Audit
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
    } catch (e) { /* don't fail on audit */ }

    return res.status(200).set(cors).json({
      success: true,
      appointment_id: appt.id,
      title: appt.title,
      date: appt.date instanceof Date ? appt.date.toISOString().slice(0,10) : appt.date,
      time: appt.time
    });
  } catch (e) {
    console.error('booking-cancel error:', e);
    return res.status(500).set(cors).json({ error: 'Server error. Please try again or contact us.' });
  }
}

exports.handler = wrap(handler);
