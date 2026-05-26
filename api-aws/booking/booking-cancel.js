// PUBLIC - no auth required, validates via opaque token
//
// POST /api/booking/cancel-appointment
//
// Cancels an appointment via a signed token from the confirmation email.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const mailgun = require('./lib/mailgun');
const { sendCancellationEmail } = require('./lib/appointment-cancellation-email');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const { getContactById } = require('./lib/contacts');
async function getContact(subaccountId, contactId) {
  return getContactById(subaccountId, contactId);
}

async function getSubaccountInfo(subaccountId) {
  const r = await db.query(`SELECT slug FROM subaccounts WHERE id = $1`, [subaccountId]);
  const d = await db.query(`SELECT data FROM subaccount_data WHERE subaccount_id = $1`, [subaccountId]);
  const settings = (d.rows[0] && d.rows[0].data && d.rows[0].data.settings) || {};
  return {
    slug: r.rows[0] ? r.rows[0].slug : null,
    bizName: settings.businessName || (r.rows[0] ? r.rows[0].slug : 'the business'),
    timezone: settings.timezone || 'America/New_York'
  };
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hh = parseInt(h, 10);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh === 0 ? 12 : (hh > 12 ? hh - 12 : hh);
  return `${h12}:${m} ${ampm}`;
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

    // Enforce the cancel window policy at click time. Look up the widget
    // (if still active) for cancel_window_hours; default 24 hours.
    const wRes = await db.query(
      `SELECT cancel_window_hours FROM service_widgets WHERE id = (
         SELECT widget_id FROM appointments WHERE id = $1
       ) LIMIT 1`,
      [appt.id]
    );
    const cancelWindowHrs = wRes.rows[0] && wRes.rows[0].cancel_window_hours != null
      ? parseInt(wRes.rows[0].cancel_window_hours) : 24;
    if (cancelWindowHrs > 0) {
      // Look up subaccount tz to compute apptTimestamp accurately.
      const subRes = await db.query(`SELECT data FROM subaccount_data WHERE subaccount_id = $1`, [tok.subaccount_id]);
      const subTz = (subRes.rows[0] && subRes.rows[0].data && subRes.rows[0].data.settings && subRes.rows[0].data.settings.timezone) || 'America/New_York';
      const tz = require('./lib/timezone');
      const dateStr = appt.date instanceof Date ? appt.date.toISOString().slice(0,10) : appt.date;
      const apptTs = tz.apptTimestampInTz(dateStr, appt.time, subTz);
      const hoursUntil = (apptTs.getTime() - Date.now()) / 3600000;
      if (hoursUntil < cancelWindowHrs) {
        return res.status(400).json({
          error: `Cancellations require at least ${cancelWindowHrs} hours notice. Please contact the business directly to cancel.`
        });
      }
    }

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

    // Send cancellation confirmation email via the canonical lib (gated by
    // Notifications tab). Non-fatal: email failure doesn't roll back the cancel.
    try {
      const contact = await getContact(tok.subaccount_id, appt.contact_id);
      const sub = await getSubaccountInfo(tok.subaccount_id);
      if (contact && contact.email && sub.slug) {
        await sendCancellationEmail({
          subaccountId: tok.subaccount_id,
          subaccountSlug: sub.slug,
          recipientEmail: contact.email,
          recipientName: contact.name || contact.first_name || '',
          contactId: contact.id,
          businessName: sub.bizName,
          appointmentTitle: appt.title || 'Appointment',
          appointmentDate: appt.date instanceof Date ? appt.date.toISOString().slice(0, 10) : appt.date,
          appointmentTime: appt.time,
          staffName: '',
          source: 'patient_self_serve'
        });
      }
    } catch (e) { console.error('Cancel email failed:', e.message); }

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
