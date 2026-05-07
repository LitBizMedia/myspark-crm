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

module.exports = {
  DEFAULT_TZ,
  getSubTimezone,
  todayInTz,
  nowInTz,
  isPastOrTodayInTz
};
