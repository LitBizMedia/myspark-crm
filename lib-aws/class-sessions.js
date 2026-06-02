// lib-aws/class-sessions.js
//
// Shared class-session recurrence engine. Extracted from services-upsert.js
// on 2026-06-02 so both the save path and the daily top-up cron use ONE copy
// of the recurrence math. Do not fork this logic. Two copies will drift and
// drift causes instructor double-booking.
//
// Exposes:
//   - generateSessionsFromRule(service, rule) -> array of session objects
//   - bulkInsertSessions(db, sessions, subaccountId) -> inserts rows
//   - parseRule(raw) -> normalized rule object or null
//   - ruleChanged(oldRule, newRule) -> bool
//   - date helpers: todayStr, horizonDateStr, parseDateLocal, formatDateLocal
//   - constants: HORIZON_DAYS, HARD_CAP_SESSIONS, DEFAULT_OCCURRENCES
//
// NOTE: bulkInsertSessions takes db as its first arg here. In the original
// services-upsert.js it closed over the module-level db require. The lib stays
// db-agnostic so each caller passes its own db handle.

const crypto = require('crypto');

const HORIZON_DAYS = 90;
const HARD_CAP_SESSIONS = 52;
const DEFAULT_OCCURRENCES = 12;

// ===== Date helpers =====

function todayStr() {
  const d = new Date();
  return formatDateLocal(d);
}

function horizonDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + HORIZON_DAYS);
  return formatDateLocal(d);
}

function parseDateLocal(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split('-');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ===== Rule comparison =====

function parseRule(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;
}

function ruleChanged(oldRule, newRule) {
  if (!oldRule && !newRule) return false;
  if (!oldRule || !newRule) return true;
  if (oldRule.repeats !== newRule.repeats) return true;
  if (oldRule.start_date !== newRule.start_date) return true;
  if (oldRule.start_time !== newRule.start_time) return true;
  if (JSON.stringify(oldRule.days_of_week || []) !== JSON.stringify(newRule.days_of_week || [])) return true;
  if ((oldRule.day_of_month || null) !== (newRule.day_of_month || null)) return true;
  if ((oldRule.end_type || 'never') !== (newRule.end_type || 'never')) return true;
  if ((oldRule.occurrences || null) !== (newRule.occurrences || null)) return true;
  if ((oldRule.end_date || null) !== (newRule.end_date || null)) return true;
  return false;
}

// ===== Recurrence engine =====

function generateSessionsFromRule(service, rule) {
  if (!rule || !rule.start_date || !rule.start_time) return [];

  const sessions = [];
  const horizonStr = horizonDateStr();

  function buildSession(dateStr) {
    return {
      id: crypto.randomUUID(),
      service_id: service.id,
      series_id: service.id,
      instructor_id: service.instructor_id || null,
      title: service.name,
      date: dateStr,
      time: rule.start_time,
      duration: parseInt(service.duration_default) || 60,
      capacity: parseInt(service.capacity) || 10,
      location: service.location || null,
      status: 'scheduled',
      is_override: false,
      price: service.price != null ? parseFloat(service.price) : null
    };
  }

  if (rule.repeats === 'once') {
    sessions.push(buildSession(rule.start_date));
    return sessions;
  }

  const endType = rule.end_type || 'never';
  let occurrencesCap = HARD_CAP_SESSIONS;
  if (endType === 'after') {
    occurrencesCap = Math.min(parseInt(rule.occurrences) || DEFAULT_OCCURRENCES, HARD_CAP_SESSIONS);
  }
  const endDateCutoff = (endType === 'on_date' && rule.end_date) ? rule.end_date : null;
  const useHorizon = (endType === 'never');

  const cursor = parseDateLocal(rule.start_date);
  if (!cursor) return [];

  const MAX_ITERATIONS = 365 * 5;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    if (sessions.length >= occurrencesCap) break;

    const cursorStr = formatDateLocal(cursor);
    if (useHorizon && cursorStr > horizonStr) break;
    if (endDateCutoff && cursorStr > endDateCutoff) break;

    let matches = false;
    if (rule.repeats === 'daily') {
      matches = true;
    } else if (rule.repeats === 'weekly') {
      const dow = rule.days_of_week || [];
      matches = dow.indexOf(cursor.getDay()) >= 0;
    } else if (rule.repeats === 'monthly') {
      const wantDay = parseInt(rule.day_of_month) || 1;
      matches = cursor.getDate() === wantDay;
    }

    if (matches) sessions.push(buildSession(cursorStr));

    cursor.setDate(cursor.getDate() + 1);
  }

  return sessions;
}

// ===== Bulk insert =====
// db is passed in so the lib does not bind to any one Lambda's db handle.

async function bulkInsertSessions(db, sessions, subaccountId) {
  if (!sessions.length) return;
  const colsPerRow = 14;
  const placeholders = [];
  const params = [];
  sessions.forEach((sess, idx) => {
    const base = idx * colsPerRow;
    placeholders.push(
      '($' + (base+1) + ',$' + (base+2) + ',$' + (base+3) + ',$' + (base+4) +
      ',$' + (base+5) + ',$' + (base+6) + ',$' + (base+7) + ',$' + (base+8) +
      ',$' + (base+9) + ',$' + (base+10) + ',$' + (base+11) + ',$' + (base+12) +
      ',$' + (base+13) + ',$' + (base+14) + ",'[]'::jsonb,NOW(),NOW())"
    );
    params.push(
      sess.id, subaccountId, sess.service_id, sess.series_id,
      sess.instructor_id, sess.title, sess.date, sess.time,
      sess.duration, sess.capacity, sess.location, sess.status,
      sess.is_override, sess.price
    );
  });
  const sql =
    `INSERT INTO class_sessions (
      id, subaccount_id, service_id, series_id, instructor_id, title,
      date, time, duration, capacity, location, status,
      is_override, price, participants, created_at, updated_at
    ) VALUES ` + placeholders.join(',');
  await db.query(sql, params);
}

module.exports = {
  HORIZON_DAYS,
  HARD_CAP_SESSIONS,
  DEFAULT_OCCURRENCES,
  todayStr,
  horizonDateStr,
  parseDateLocal,
  formatDateLocal,
  parseRule,
  ruleChanged,
  generateSessionsFromRule,
  bulkInsertSessions
};
