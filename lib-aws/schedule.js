// lib/schedule.js
// Shared schedule helpers for the booking Lambdas.
//
// Computes "available windows" for a given staff member on a given date,
// honoring:
//   - daily on/off schedule per weekday (schedule.{day}.on/start/end)
//   - daily lunch break (schedule.{day}.hasLunch + lunchStart + lunchEnd)
//   - date overrides:
//       type 'off'      -> entire day unavailable (returns no windows)
//       type 'hoursOff' -> override.start..end is removed from the day's windows
//       type 'custom'   -> override.start..end REPLACES the day's schedule
//
// Times throughout are minutes-from-midnight (0..1439). Windows are returned
// as [startMin, endMin] tuples in chronological order.
//
// Used by booking-availability.js (slot generation) and booking-submit.js
// (server-side validation that the submitted time fits an available window).

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function timeToMins(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dayKeyForDate(dateStr) {
  return DAY_KEYS[new Date(dateStr + 'T12:00:00').getDay()];
}

// Subtract a single [gStart, gEnd] gap from a list of [start, end] windows,
// splitting any window that the gap overlaps.
function subtractGap(windows, gStart, gEnd) {
  if (gEnd <= gStart) return windows;
  const out = [];
  for (const [wStart, wEnd] of windows) {
    if (gEnd <= wStart || gStart >= wEnd) {
      out.push([wStart, wEnd]);
      continue;
    }
    if (gStart > wStart) out.push([wStart, gStart]);
    if (gEnd < wEnd) out.push([gEnd, wEnd]);
  }
  return out;
}

// Returns the list of [startMin, endMin] windows during which the staff is
// available on the given date. Empty array means fully unavailable.
function buildAvailableWindows(staff, dateStr) {
  if (!staff) return [];
  const schedule = staff.schedule || {};
  const dateOverrides = staff.dateOverrides || staff.date_overrides || [];
  const dayKey = dayKeyForDate(dateStr);
  const daySchedule = schedule[dayKey];
  const override = (Array.isArray(dateOverrides) ? dateOverrides : []).find(o => o && o.date === dateStr) || null;

  if (override && override.type === 'off') return [];

  let workStart, workEnd;
  if (override && override.type === 'custom' && override.start && override.end) {
    workStart = timeToMins(override.start);
    workEnd = timeToMins(override.end);
  } else if (daySchedule && daySchedule.on) {
    workStart = timeToMins(daySchedule.start || '08:00');
    workEnd = timeToMins(daySchedule.end || '17:00');
  } else {
    return [];
  }
  if (workStart >= workEnd) return [];

  let windows = [[workStart, workEnd]];

  // Subtract lunch break only when running on the regular schedule (not
  // when a custom override has replaced the day).
  if (
    !(override && override.type === 'custom') &&
    daySchedule && daySchedule.on &&
    daySchedule.hasLunch && daySchedule.lunchStart && daySchedule.lunchEnd
  ) {
    windows = subtractGap(windows, timeToMins(daySchedule.lunchStart), timeToMins(daySchedule.lunchEnd));
  }

  // Subtract Hours Off override range.
  if (override && override.type === 'hoursOff' && override.start && override.end) {
    windows = subtractGap(windows, timeToMins(override.start), timeToMins(override.end));
  }

  return windows;
}

// Intersects each window in `windows` with [start, end]. Used to apply a
// service- or widget-level availability window on top of the staff schedule.
function intersectWindows(windows, start, end) {
  const out = [];
  for (const [wStart, wEnd] of windows) {
    const s = Math.max(wStart, start);
    const e = Math.min(wEnd, end);
    if (s < e) out.push([s, e]);
  }
  return out;
}

// True iff [timeMin, timeMin + durationMin) lies entirely within one of
// the available windows. Used for server-side defense in booking-submit.
function isTimeAvailable(staff, dateStr, timeStr, durationMin) {
  const start = timeToMins(timeStr);
  const end = start + (parseInt(durationMin) || 0);
  const windows = buildAvailableWindows(staff, dateStr);
  for (const [wStart, wEnd] of windows) {
    if (start >= wStart && end <= wEnd) return true;
  }
  return false;
}

module.exports = {
  DAY_KEYS,
  timeToMins,
  dayKeyForDate,
  buildAvailableWindows,
  intersectWindows,
  isTimeAvailable
};
