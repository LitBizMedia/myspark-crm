// PUBLIC - no auth required, validates via opaque token
//
// GET  /api/booking/reschedule-info?token=X    -> appointment context
// POST /api/booking/reschedule-confirm         -> { token, date, time }

const db = require('./lib/db');
const { resolveResourceClaims, replaceClaims } = require('./lib/resource-allocation');
const { checkStaffConflict } = require('./lib/staff-conflict');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const mailgun = require('./lib/mailgun');
const crypto = require('crypto');

function genActionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
            duration, service_id, service_variation_id, appointment_type_id, widget_id
       FROM appointments WHERE id = $1 AND subaccount_id = $2`,
    [tok.appointment_id, tok.subaccount_id]
  );
  if (apptRes.rows.length === 0) return null;
  return apptRes.rows[0];
}

async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    if (req.method === 'GET') {
      const token = (req.query && req.query.token) || '';
      const { tok, error } = await loadToken(token);
      if (error) return res.status(error.status).json({ error: error.msg });
      const appt = await loadAppt(tok);
      if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
      if (appt.status === 'cancelled') return res.status(400).json({ error: 'This appointment is cancelled.' });

      const subRes = await db.query(`SELECT slug FROM subaccounts WHERE id = $1`, [tok.subaccount_id]);
      const slug = subRes.rows[0] ? subRes.rows[0].slug : null;

      return res.status(200).json({
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
          service_variation_id: appt.service_variation_id,
          appointment_type_id: appt.appointment_type_id
        }
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    const token = (body.token || '').toString().trim();
    const newDate = (body.date || '').toString().trim();
    const newTime = (body.time || '').toString().trim();
    if (!newDate || !newTime) return res.status(400).json({ error: 'New date and time are required.' });

    const { tok, error } = await loadToken(token);
    if (error) return res.status(error.status).json({ error: error.msg });
    const appt = await loadAppt(tok);
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
    if (appt.status === 'cancelled') return res.status(400).json({ error: 'This appointment is cancelled.' });

    // Enforce reschedule window policy at confirm time. Same window as cancel.
    const wRes = await db.query(
      `SELECT cancel_window_hours FROM service_widgets WHERE id = (
         SELECT widget_id FROM appointments WHERE id = $1
       ) LIMIT 1`,
      [appt.id]
    );
    const cancelWindowHrs = wRes.rows[0] && wRes.rows[0].cancel_window_hours != null
      ? parseInt(wRes.rows[0].cancel_window_hours) : 24;
    if (cancelWindowHrs > 0) {
      const subRes = await db.query(`SELECT data FROM subaccount_data WHERE subaccount_id = $1`, [tok.subaccount_id]);
      const subTz = (subRes.rows[0] && subRes.rows[0].data && subRes.rows[0].data.settings && subRes.rows[0].data.settings.timezone) || 'America/New_York';
      const tz = require('./lib/timezone');
      const dateStr = appt.date instanceof Date ? appt.date.toISOString().slice(0,10) : appt.date;
      const apptTs = tz.apptTimestampInTz(dateStr, appt.time, subTz);
      const hoursUntil = (apptTs.getTime() - Date.now()) / 3600000;
      if (hoursUntil < cancelWindowHrs) {
        return res.status(400).json({
          error: `Reschedules require at least ${cancelWindowHrs} hours notice. Please contact the business directly.`
        });
      }
    }

    // Time-conflict check via shared helper.
    if (appt.assigned_to) {
      try {
        const result = await checkStaffConflict({
          staffId: appt.assigned_to,
          subaccountId: tok.subaccount_id,
          date: newDate,
          time: newTime,
          duration: appt.duration,
          ignoreAppointmentId: appt.id,
          dbClient: db
        });
        if (!result.ok) {
          return res.status(409).json({ error: 'That time is no longer available. Please choose another.' });
        }
      } catch (cErr) {
        console.warn('[reschedule] time conflict check skipped:', cErr.message);
      }
    }

    // Resource availability check. Hard block: the new time must not collide
    // with another appointment claiming the same required resources.
    let newResourceClaims = [];
    if (appt.service_id) {
      try {
        const dur = parseInt(appt.duration) || 60;
        const result = await resolveResourceClaims({
          serviceId: appt.service_id,
          subaccountId: tok.subaccount_id,
          date: newDate,
          time: newTime,
          duration: dur,
          ignoreAppointmentId: appt.id,
          dbClient: db
        });
        if (!result.ok) {
          const reasons = (result.conflicts || []).map(c => {
            const tried = (c.attempted || []).map(x => x.name).filter(Boolean);
            if (!tried.length) return 'a required resource is unavailable';
            if (tried.length === 1) return tried[0] + ' is already booked';
            return 'all of [' + tried.join(', ') + '] are already booked';
          });
          return res.status(409).json({
            error: 'resource_unavailable',
            message: 'That time is no longer available: ' + reasons.join(', and ') + '. Please choose another time.'
          });
        }
        newResourceClaims = result.claims;
      } catch (rErr) {
        console.warn('[reschedule] resource check skipped:', rErr.message);
      }
    }

    await db.query(
      `UPDATE appointments SET date = $1, time = $2, updated_at = NOW() WHERE id = $3`,
      [newDate, newTime, appt.id]
    );

    // Replace resource claims with the newly-resolved ones for the new time.
    try {
      await replaceClaims({
        dbClient: db,
        appointmentId: appt.id,
        claims: newResourceClaims
      });
    } catch (claimErr) {
      console.warn('[reschedule] claim replace failed:', claimErr.message);
    }
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

    // Issue fresh cancel/reschedule tokens for the moved appointment so the
    // customer can manage it again from the new confirmation email.
    let newCancelLink = '';
    let newReschedLink = '';
    try {
      const tz = require('./lib/timezone');
      const sub = await getSubaccountInfo(tok.subaccount_id);
      const newApptTs = tz.apptTimestampInTz(newDate, newTime, sub.timezone);
      if (newApptTs > new Date()) {
        const cancelTok = genActionToken();
        const reschedTok = genActionToken();
        await db.query(
          `INSERT INTO booking_action_tokens (token, appointment_id, subaccount_id, action, expires_at)
           VALUES ($1, $2, $3, 'cancel', $4),
                  ($5, $6, $7, 'reschedule', $8)`,
          [cancelTok,  appt.id, tok.subaccount_id, newApptTs.toISOString(),
           reschedTok, appt.id, tok.subaccount_id, newApptTs.toISOString()]
        );
        newCancelLink  = `https://book.mysparkplus.app/cancel?token=${cancelTok}`;
        newReschedLink = `https://book.mysparkplus.app/reschedule?token=${reschedTok}`;
      }

      // Send reschedule confirmation email
      const contact = await getContact(tok.subaccount_id, appt.contact_id);
      if (contact && contact.email && sub.slug) {
        const html = `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <h2 style="margin-bottom:4px;color:#1a1030">Appointment Rescheduled</h2>
            <p style="color:#6b7280;margin-top:0">${sub.bizName}</p>
            <div style="background:#f9f7ff;border-radius:8px;padding:20px;margin:20px 0">
              <div style="margin-bottom:8px"><strong>Service:</strong> ${appt.title || 'Appointment'}</div>
              <div style="margin-bottom:8px"><strong>New Date:</strong> ${newDate}</div>
              <div style="margin-bottom:8px"><strong>New Time:</strong> ${fmtTime(newTime)}</div>
            </div>
            ${(newCancelLink || newReschedLink) ? `
              <div style="margin:20px 0 8px;padding:14px 16px;background:#f3f1ff;border-radius:8px">
                <div style="font-size:13px;color:#5a4d7a;margin-bottom:8px">Need to make changes?</div>
                <div style="font-size:14px">
                  ${newReschedLink ? `<a href="${newReschedLink}" style="color:#6b21ea;text-decoration:underline;margin-right:14px">Reschedule</a>` : ''}
                  ${newCancelLink ? `<a href="${newCancelLink}" style="color:#6b21ea;text-decoration:underline">Cancel appointment</a>` : ''}
                </div>
              </div>
            ` : ''}
            <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:16px">Powered by MySpark+</p>
          </div>`;
        await mailgun.sendEmail(sub.slug, {
          scope: 'subaccount',
          source: 'confirmation',
          to: contact.email,
          subject: `Appointment Rescheduled - ${sub.bizName}`,
          html,
          contactId: appt.contact_id
        });
      }
    } catch (e) { console.error('Reschedule email/tokens failed:', e.message); }

    return res.status(200).json({
      success: true,
      appointment_id: appt.id,
      date: newDate,
      time: newTime
    });
  } catch (e) {
    console.error('booking-reschedule error:', e);
    return res.status(500).json({ error: 'Server error. Please try again or contact us.' });
  }
}

exports.handler = wrap(handler);
