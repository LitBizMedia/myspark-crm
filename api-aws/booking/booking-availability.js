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

  const { slug, service_id, variation_id, staff_id, date } = req.query;
  if (!slug || !service_id || !date)
    return res.status(400).json({ error: 'slug, service_id, and date are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });

  try {
    // 1. Subaccount
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Service
    const svcResult = await db.query(
      'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1',
      [service_id, subaccountId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });
    const service = svcResult.rows[0];

    // 3. Variation overrides
    let duration  = service.duration_default || 60;
    let bufBefore = service.buffer_before    || 0;
    let bufAfter  = service.buffer_after     || 0;

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

    // 4. Blob for users + settings
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const bs       = settings.bookingSettings || {};
    const leadTimeHours = service.booking_lead_time_hours || 0;

    // 5. Staff pool: IDs from agency_users, schedule from blob
    const assignedStaff = Array.isArray(service.assigned_staff) ? service.assigned_staff : [];
    const staffDbResult = await db.query(
      'SELECT id, username, name FROM agency_users WHERE subaccount_id = $1 AND active = true',
      [subaccountId]
    );
    const blobUsers2 = blob.users || [];
    let staffPool = staffDbResult.rows.map(u => {
      const blobUser = blobUsers2.find(b => b.id === u.id) || {};
      return {
        id: u.id,
        name: u.name || u.username,
        schedule: blobUser.schedule || {},
        dateOverrides: blobUser.dateOverrides || []
      };
    });
    if (staff_id && staff_id !== 'any') {
      staffPool = staffPool.filter(u => u.id === staff_id);
    } else if (assignedStaff.length) {
      staffPool = staffPool.filter(u => assignedStaff.includes(u.id));
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
      const avail = (service.availability && typeof service.availability === 'object') ? service.availability : {};
      const staffSlots = getSlotsForStaff(staff, date, duration, bufBefore, bufAfter, appts, leadTimeHours, avail);
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
