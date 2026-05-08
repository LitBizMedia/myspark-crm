// api/booking/booking-availability.js
// GET /api/booking/availability?slug=SLUG&service_id=SID&staff_id=UID|any&date=YYYY-MM-DD
// PUBLIC - no auth required
// Returns available time slots for a given service/staff/date.
//
// CHANGED 2026-05-08: slot generation now uses lib/schedule.buildAvailableWindows
// so that lunch breaks (schedule.hasLunch + lunchStart + lunchEnd) and
// Hours Off / Work These Hours overrides are honored. Previously only the
// outer day boundary and 'off' override type were considered.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz, nowMinutesInTz } = require('./lib/timezone');
const { buildAvailableWindows, intersectWindows, timeToMins, dayKeyForDate } = require('./lib/schedule');

function minsToTime(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function getSlotsForStaff(staff, date, duration, bufBefore, bufAfter, appts, leadTimeHours, serviceAvailability, strictAvailability, tz, slotIntervalMinutes) {
  let windows = buildAvailableWindows(staff, date);
  if (!windows.length) return [];

  const dayKey = dayKeyForDate(date);
  const hasAnyAvail = serviceAvailability && Object.keys(serviceAvailability).length > 0;
  if (hasAnyAvail) {
    const sAvail = serviceAvailability[dayKey];
    if (!sAvail || !sAvail.on) {
      if (strictAvailability) return [];
    } else {
      const sStart = timeToMins(sAvail.start || '08:00');
      const sEnd = timeToMins(sAvail.end || '17:00');
      windows = intersectWindows(windows, sStart, sEnd);
      if (!windows.length) return [];
    }
  }

  const tzToday = todayInTz(tz);
  let cutoffMins = 0;
  if (date === tzToday) {
    cutoffMins = nowMinutesInTz(tz) + leadTimeHours * 60;
  }

  const step = (slotIntervalMinutes && slotIntervalMinutes > 0) ? slotIntervalMinutes : 15;
  const slots = [];

  for (const [wStart, wEnd] of windows) {
    for (let t = wStart; t + duration <= wEnd; t += step) {
      if (t < cutoffMins) continue;

      const slotCalStart = t - bufBefore;
      const slotCalEnd = t + duration + bufAfter;

      let conflict = false;
      for (const appt of appts) {
        if (appt.status === 'cancelled') continue;
        const aStart = timeToMins(appt.time || '00:00');
        const aBufB = parseInt(appt.buffer_before) || 0;
        const aBufA = parseInt(appt.buffer_after) || 0;
        const aCalStart = aStart - aBufB;
        const aCalEnd = aStart + (parseInt(appt.duration) || 60) + aBufA;
        if (slotCalStart < aCalEnd && slotCalEnd > aCalStart) { conflict = true; break; }
      }

      if (!conflict) slots.push({ time: minsToTime(t), staff_id: staff.id });
    }
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
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    let service = null;
    let widget = null;
    let duration = 60;
    let bufBefore = 0;
    let bufAfter = 0;
    let leadTimeHours = 0;
    let serviceAvailabilityWindow = {};

    if (appointment_type_id) {
      const wRes = await db.query(
        `SELECT id, widget_type, staff_ids, appointment_types, widget_availability,
                booking_lead_time_hours, booking_advance_days,
                buffer_before_override, buffer_after_override, slot_interval_minutes
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
      leadTimeHours = 0;
      serviceAvailabilityWindow = (widget.widget_availability && typeof widget.widget_availability === 'object')
        ? widget.widget_availability
        : {};
    } else {
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

      if (widget_id) {
        const wExtraRes = await db.query(
          `SELECT booking_lead_time_hours, booking_advance_days,
                  buffer_before_override, buffer_after_override, slot_interval_minutes
           FROM service_widgets
           WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1`,
          [widget_id, subaccountId]
        );
        if (wExtraRes.rows.length) widget = Object.assign(widget || {}, wExtraRes.rows[0]);
      }
    }

    if (widget) {
      if (widget.buffer_before_override != null) bufBefore = parseInt(widget.buffer_before_override) || 0;
      if (widget.buffer_after_override  != null) bufAfter  = parseInt(widget.buffer_after_override)  || 0;
      if (widget.booking_lead_time_hours != null) {
        leadTimeHours = parseInt(widget.booking_lead_time_hours) || 0;
      }
    }

    if (widget && widget.booking_advance_days != null) {
      const maxDays = parseInt(widget.booking_advance_days) || 0;
      if (maxDays > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const today = new Date(todayStr + 'T00:00:00Z');
        const requested = new Date(date + 'T00:00:00Z');
        const daysAhead = (requested - today) / 86400000;
        if (daysAhead > maxDays) {
          return res.status(200).json({ slots: [], duration, date });
        }
      }
    }

    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const subTz = settings.timezone || 'America/Chicago';

    const blackoutDates = Array.isArray(settings.blackoutDates) ? settings.blackoutDates : [];
    if (blackoutDates.some(b => b && b.date === date)) {
      return res.status(200).json({ slots: [], duration, date, blackout: true });
    }

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

    const dayCounts = {};
    for (const a of apptResult.rows) {
      if (a.status === 'cancelled') continue;
      dayCounts[a.assigned_to] = (dayCounts[a.assigned_to] || 0) + 1;
    }
    staffPool = staffPool.filter(u => {
      const max = u.schedule && u.schedule.maxBookingsPerDay;
      const maxN = (max != null) ? parseInt(max) : 0;
      if (!maxN || maxN <= 0) return true;
      return (dayCounts[u.id] || 0) < maxN;
    });
    if (!staffPool.length) return res.status(200).json({ slots: [], duration, date });

    const strictAvailability = !!appointment_type_id;
    const slotInterval = (widget && widget.slot_interval_minutes) ? parseInt(widget.slot_interval_minutes) || 15 : 15;
    const slotMap = {};
    for (const staff of staffPool) {
      const appts = apptsByStaff[staff.id] || [];
      const staffSlots = getSlotsForStaff(staff, date, duration, bufBefore, bufAfter, appts, leadTimeHours, serviceAvailabilityWindow, strictAvailability, subTz, slotInterval);
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
