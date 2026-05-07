// lib-aws/timezone.js
//
// Single source of truth for "today" and date/time formatting in the
// subaccount's timezone. All Lambdas that need date-bound logic should use
// these helpers instead of naive UTC operations.
//
// Usage:
//   const { todayInTz, getSubTimezone } = require('./timezone');
//   const tz = await getSubTimezone(subaccountId, db);
//   const today = todayInTz(tz);  // 'YYYY-MM-DD' in that TZ

const DEFAULT_TZ = 'America/New_York';

// Read the subaccount's stored timezone from the blob. Returns the IANA TZ
// string (e.g. 'America/New_York') or DEFAULT_TZ if not set.
async function getSubTimezone(subaccountId, db) {
  if (!subaccountId || !db) return DEFAULT_TZ;
  try {
    const r = await db.query(
      "SELECT data->'settings'->>'timezone' AS tz FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1",
      [subaccountId]
    );
    if (r.rows.length && r.rows[0].tz) return r.rows[0].tz;
  } catch (_) { /* fall through */ }
  return DEFAULT_TZ;
}

// Today's calendar date as 'YYYY-MM-DD' in the given TZ.
// Pass an IANA TZ string (e.g. 'America/New_York').
function todayInTz(tz) {
  const zone = tz || DEFAULT_TZ;
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: zone });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

// "Now" formatted as ISO-ish for logs/displays in the given TZ.
function nowInTz(tz) {
  const zone = tz || DEFAULT_TZ;
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (_) {
    return new Date().toISOString();
  }
}

// Compare a date string (YYYY-MM-DD) to "today" in the given TZ.
// Returns true if dateStr is today or in the past.
function isPastOrTodayInTz(dateStr, tz) {
  if (!dateStr) return false;
  const today = todayInTz(tz);
  return String(dateStr).slice(0, 10) <= today;
}

// Current minute-of-day (0-1439) in the given TZ.
// Use for "is this time slot still bookable today" checks where we need
// minutes since midnight in the user's local time.
function nowMinutesInTz(tz) {
  const zone = tz || DEFAULT_TZ;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: false, timeZone: zone
    }).formatToParts(new Date());
    const hh = parseInt(parts.find(p => p.type === 'hour').value, 10) || 0;
    const mm = parseInt(parts.find(p => p.type === 'minute').value, 10) || 0;
    return (hh % 24) * 60 + mm;
  } catch (_) {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

// Today + N days as YYYY-MM-DD in the given TZ. Avoids DST edge cases by
// doing the arithmetic on the date string itself.
function dateInTzPlusDays(days, tz) {
  const today = todayInTz(tz);
  const [y, m, d] = today.split('-').map(Number);
  const future = new Date(Date.UTC(y, m - 1, d + days));
  return future.toISOString().slice(0, 10);
}

// Given a date string + time string + IANA TZ, returns the absolute Date
// representing that wall-clock moment in that TZ.
//
// Example: apptTimestampInTz('2026-05-08', '09:00', 'America/New_York')
// returns the Date object for May 8 9am Eastern (whatever UTC that maps to,
// accounting for DST automatically).
function apptTimestampInTz(dateStr, timeStr, tz) {
  if (!dateStr) return null;
  const zone = tz || DEFAULT_TZ;
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);

  // Step 1: pretend the wall time is UTC, get a guess timestamp
  const guessUtc = Date.UTC(y, mo - 1, d, h, m, 0);

  // Step 2: see what that UTC moment looks like when displayed in tz
  let observedMs;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(guessUtc))) {
      if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
    }
    observedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  } catch (_) {
    return new Date(guessUtc);
  }

  // The diff is how many ms the tz is offset from UTC at that moment.
  // Add it back to guessUtc to get the actual UTC time when the wall clock
  // in tz reads "y-mo-d h:m".
  const offsetMs = guessUtc - observedMs;
  return new Date(guessUtc + offsetMs);
}

// Add N months to today's date in the given TZ. Returns YYYY-MM-DD.
// Mirrors JS Date semantics for end-of-month: Jan 31 + 1 month = March 3,
// matching the existing billing logic so renewals stay consistent.
function addMonthsInTz(months, tz) {
  const today = todayInTz(tz);
  const [y, mo, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

// Calculate the next billing date for a billing period (monthly | annual).
// "Today" is interpreted in the given TZ. Returns YYYY-MM-DD.
function nextBillingDateInTz(billingPeriod, tz) {
  if (billingPeriod === 'annual') {
    return addMonthsInTz(12, tz);
  }
  return addMonthsInTz(1, tz);
}

module.exports = {
  DEFAULT_TZ,
  getSubTimezone,
  todayInTz,
  nowInTz,
  isPastOrTodayInTz,
  nowMinutesInTz,
  dateInTzPlusDays,
  apptTimestampInTz,
  addMonthsInTz,
  nextBillingDateInTz
};
