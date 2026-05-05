// api/booking/booking-availability.js
// GET /api/booking/availability?slug=SLUG&service_id=SID&staff_id=UID|any&date=YYYY-MM-DD
// PUBLIC - no auth required
// Returns available time slots for a given service/staff/date

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function timeToMins(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}

function minsToTime(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function getSlotsForStaff(staff, date, duration, bufBefore, bufAfter, appts, leadTimeHours, serviceAvailability) {
  const dayKey = DAY_KEYS[new Date(date + 'T12:00:00').getDay()];
  const schedule = staff.schedule || {};
  const daySchedule = schedule[dayKey];
  if (!daySchedule || !daySchedule.on) return [];

  // Check date overrides
  const override = (staff.dateOverrides || []).find(o => o.date === date);
  if (override && override.type === 'off') return [];

  let workStart = timeToMins(daySchedule.start || '08:00');
  let workEnd   = timeToMins(daySchedule.end   || '17:00');

  // Intersect with service availability window if defined
  if (serviceAvailability && serviceAvailability[dayKey]) {
    const sAvail = serviceAvailability[dayKey];
    if (!sAvail.on) return [];
    workStart = Math.max(workStart, timeToMins(sAvail.start || '08:00'));
    workEnd   = Math.min(workEnd,   timeToMins(sAvail.end   || '17:00'));
  }

  if (workStart >= workEnd) return [];

  // Lead time cutoff in clinic local minutes (rough - no tz conversion yet)
  const now = new Date();
  const todayUtc = now.toISOString().split('T')[0];
  const cutoffMins = (date === todayUtc)
    ? now.getHours() * 60 + now.getMinutes() + leadTimeHours * 60
    : 0;

  const slots = [];
  for (let t = workStart; t + duration <= workEnd; t += 15) {
    if (t < cutoffMins) continue;

    // Calendar block for this slot: [t - bufBefore, t + duration + bufAfter]
    const slotCalStart = t - bufBefore;
    const slotCalEnd   = t + duration + bufAfter;

    let conflict = false;
    for (const appt of appts) {
      if (appt.status === 'cancelled') continue;
      const aStart    = timeToMins(appt.time || '00:00');
      const aBufB     = parseInt(appt.buffer_before)  || 0;
      const aBufA     = parseInt(appt.buffer_after)   || 0;
      const aCalStart = aStart - aBufB;
      const aCalEnd   = aStart + (parseInt(appt.duration) || 60) + aBufA;
      if (slotCalStart < aCalEnd && slotCalEnd > aCalStart) { conflict = true; break; }
    }

    if (!conflict) slots.push({ time: minsToTime(t), staff_id: staff.id });
  }
  return slots;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, service_id, variation_id, appointment_type_id, widget_id, staff_id, date } = req.query;
  if (!slug || !date)
    return res.status(400).json({ error: 'slug and date are required' });
  if (!service_id && !appointment_type_id)
    return res.status(400).json({ error: 'service_id or appointment_type_id is required' });
  if (appointment_type_id && !widget_id)
    return res.status(400).json({ error: 'widget_id is required when using appointment_type_id' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });

  try {
    // 1. Subaccount
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Look up the bookable item: service OR appointment type from widget JSONB.
    // Both branches produce the same downstream values: duration, buffers, and
    // the staff pool to filter against.
    let service = null;
    let widget = null;
    let duration = 60;
    let bufBefore = 0;
    let bufAfter = 0;
    let leadTimeHours = 0;
    let serviceAvailabilityWindow = {};

    if (appointment_type_id) {
      // Appointment widget path: pull duration/buffers from widget.appointment_types
      const wRes = await db.query(
        `SELECT id, widget_type, staff_ids, appointment_types, booking_lead_time_hours
         FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wRes.rows.length) return res.status(404).json({ error: 'Widget not found or inactive' });
      widget = wRes.rows[0];

      if (widget.widget_type !== 'appointment') {
        return res.status(400).json({ error: 'This widget does not support appointment types' });
      }

      const types = Array.isArray(widget.appointment_types) ? widget.appointment_types : [];
      const aType = types.find(t => t && t.id === appointment_type_id && t.active !== false);
      if (!aType) return res.status(404).json({ error: 'Appointment type not found or inactive' });

      duration = parseInt(aType.duration) || 30;
      bufBefore = parseInt(aType.buffer_before) || 0;
      bufAfter = parseInt(aType.buffer_after) || 0;
      leadTimeHours = parseInt(widget.booking_lead_time_hours) || 0;
      // Appointment widgets don't have a service availability window.
    } else {
      // Service widget path
      const svcResult = await db.query(
        'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1',
        [service_id, subaccountId]
      );
      if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });
      service = svcResult.rows[0];

      duration  = service.duration_default || 60;
      bufBefore = service.buffer_before    || 0;
      bufAfter  = service.buffer_after     || 0;
      leadTimeHours = service.booking_lead_time_hours || 0;
      serviceAvailabilityWindow = (service.availability && typeof service.availability === 'object') ? service.availability : {};

      // Variation overrides
      if (variation_id) {
        const varResult = await db.query(
          'SELECT * FROM service_variations WHERE id = $1 AND service_id = $2 LIMIT 1',
          [variation_id, service_id]
        );
        if (varResult.rows.length) {
          const v = varResult.rows[0];
          duration  = v.duration             || duration;
          bufBefore = v.buffer_before != null ? v.buffer_before : bufBefore;
          bufAfter  = v.buffer_after  != null ? v.buffer_after  : bufAfter;
        }
      }
    }

    // 4. Blob for users + settings
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const bs       = settings.bookingSettings || {};
    // leadTimeHours and serviceAvailabilityWindow already set in the lookup branch above

    // 5. Staff pool: from subaccount_users (single source of truth).
    // Service widgets filter by service.assigned_staff; appointment widgets by widget.staff_ids.
    let allowedStaffIds = [];
    if (service) {
      allowedStaffIds = Array.isArray(service.assigned_staff) ? service.assigned_staff : [];
    } else if (widget) {
      allowedStaffIds = Array.isArray(widget.staff_ids) ? widget.staff_ids : [];
    }
    const staffDbResult = await db.query(
      `SELECT id, username, display_name, schedule, date_overrides
       FROM subaccount_users
       WHERE subaccount_id = $1 AND active = true`,
      [subaccountId]
    );
    let staffPool = staffDbResult.rows.map(u => ({
      id: u.id,
      name: u.display_name || u.username,
      schedule: u.schedule || {},
      dateOverrides: u.date_overrides || []
    }));
    if (staff_id && staff_id !== 'any') {
      staffPool = staffPool.filter(u => u.id === staff_id);
    } else if (allowedStaffIds.length) {
      staffPool = staffPool.filter(u => allowedStaffIds.includes(u.id));
    }
    if (!staffPool.length) return res.status(200).json({ slots: [], duration, date });

    // 6. Existing appointments for those staff on this date
    const staffIds = staffPool.map(u => u.id);
    const apptResult = await db.query(
      `SELECT assigned_to, time, duration, buffer_before, buffer_after, status
       FROM appointments
       WHERE subaccount_id = $1 AND date = $2 AND assigned_to = ANY($3)`,
      [subaccountId, date, staffIds]
    );
    const apptsByStaff = {};
    for (const a of apptResult.rows) {
      if (!apptsByStaff[a.assigned_to]) apptsByStaff[a.assigned_to] = [];
      apptsByStaff[a.assigned_to].push(a);
    }

    // 7. Compute available slots
    const slotMap = {};
    for (const staff of staffPool) {
      const appts = apptsByStaff[staff.id] || [];
      const staffSlots = getSlotsForStaff(staff, date, duration, bufBefore, bufAfter, appts, leadTimeHours, serviceAvailabilityWindow);
      for (const s of staffSlots) {
        if (!slotMap[s.time]) slotMap[s.time] = [];
        slotMap[s.time].push(staff.id);
      }
    }

    const slots = Object.keys(slotMap).sort().map(time => ({
      time,
      available_staff: slotMap[time]
    }));

    return res.status(200).json({ slots, duration, date });
  } catch (e) {
    console.error('booking-availability error:', e.message);
    return res.status(500).json({ error: 'Failed to check availability' });
  }
}

exports.handler = wrap(handler);
