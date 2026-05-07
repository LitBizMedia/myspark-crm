// PUBLIC - no auth required, validates via opaque token
//
// Two endpoints in one Lambda:
//   GET /api/booking/reschedule-info?token=X
//     Returns appointment context for the reschedule UI.
//   POST /api/booking/reschedule-confirm
//     Body: { token, date, time }
//     Updates the appointment to the new date/time, marks token used.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

const cors = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type'
};

async function loadToken(token) {
  if (!token) return { error: { status: 400, msg: 'Missing token' } };
  const tokRes = await db.query(
    `SELECT token, appointment_id, subaccount_id, action, expires_at, used_at
       FROM booking_action_tokens WHERE token = $1`,
    [token]
  );
  if (tokRes.rows.length === 0) return { error: { status: 404, msg: 'Invalid or expired link.' } };
  const tok = tokRes.rows[0];
  if (tok.action !== 'reschedule') return { error: { status: 400, msg: 'This link is not for rescheduling.' } };
  if (tok.used_at) return { error: { status: 400, msg: 'This reschedule link was already used.' } };
  if (new Date(tok.expires_at) < new Date()) return { error: { status: 400, msg: 'This reschedule link has expired.' } };
  return { tok };
}

async function loadAppt(tok) {
  const apptRes = await db.query(
    `SELECT id, title, date, time, status, contact_id, assigned_to,
            duration, service_id, service_variation_id, widget_id
       FROM appointments
      WHERE id = $1 AND subaccount_id = $2`,
    [tok.appointment_id, tok.subaccount_id]
  );
  if (apptRes.rows.length === 0) return null;
  return apptRes.rows[0];
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(cors).send('');

  if (req.method === 'GET') {
    // Return info for the reschedule page to render
    const token = (req.query && req.query.token) || '';
    const { tok, error } = await loadToken(token);
    if (error) return res.status(error.status).set(cors).json({ error: error.msg });
    const appt = await loadAppt(tok);
    if (!appt) return res.status(404).set(cors).json({ error: 'Appointment not found.' });
    if (appt.status === 'cancelled') return res.status(400).set(cors).json({ error: 'This appointment is cancelled.' });

    // Lookup subaccount slug for the reschedule UI
    const subRes = await db.query(`SELECT slug FROM subaccounts WHERE id = $1`, [tok.subaccount_id]);
    const slug = subRes.rows[0] ? subRes.rows[0].slug : null;

    return res.status(200).set(cors).json({
      success: true,
      slug,
      widget_id: appt.widget_id,
      appointment: {
        id: appt.id,
        title: appt.title,
        date: appt.date instanceof Date ? appt.date.toISOString().slice(0,10) : appt.date,
        time: appt.time,
        duration: appt.duration,
        assigned_to: appt.assigned_to,
        service_id: appt.service_id,
        service_variation_id: appt.service_variation_id
      }
    });
  }

  if (req.method !== 'POST') return res.status(405).set(cors).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const token = (body.token || '').toString().trim();
  const newDate = (body.date || '').toString().trim();
  const newTime = (body.time || '').toString().trim();
  if (!newDate || !newTime) return res.status(400).set(cors).json({ error: 'New date and time are required.' });

  const { tok, error } = await loadToken(token);
  if (error) return res.status(error.status).set(cors).json({ error: error.msg });
  const appt = await loadAppt(tok);
  if (!appt) return res.status(404).set(cors).json({ error: 'Appointment not found.' });
  if (appt.status === 'cancelled') return res.status(400).set(cors).json({ error: 'This appointment is cancelled.' });

  // Race check at the new slot for the same staff member
  if (appt.assigned_to) {
    const conflict = await db.query(
      `SELECT id FROM appointments
        WHERE subaccount_id = $1
          AND assigned_to = $2
          AND date = $3 AND time = $4
          AND status != 'cancelled'
          AND id != $5
        LIMIT 1`,
      [tok.subaccount_id, appt.assigned_to, newDate, newTime, appt.id]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).set(cors).json({ error: 'That time is no longer available. Please choose another.' });
    }
  }

  // Perform the update
  await db.query(
    `UPDATE appointments
        SET date = $1, time = $2, updated_at = NOW()
      WHERE id = $3`,
    [newDate, newTime, appt.id]
  );
  await db.query(
    `UPDATE booking_action_tokens SET used_at = NOW() WHERE token = $1`,
    [token]
  );

  try {
    await logAudit({
      subaccountId: tok.subaccount_id,
      action: 'booking.appointment.reschedule',
      actorType: 'public',
      actorId: appt.contact_id || null,
      targetType: 'appointment',
      targetId: appt.id,
      metadata: { via: 'self_serve_link', from: { date: appt.date, time: appt.time }, to: { date: newDate, time: newTime } }
    });
  } catch (e) { /* swallow */ }

  return res.status(200).set(cors).json({
    success: true,
    appointment_id: appt.id,
    date: newDate,
    time: newTime
  });
}

exports.handler = wrap(handler);
