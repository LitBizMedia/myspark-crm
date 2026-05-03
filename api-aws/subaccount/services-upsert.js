// POST /api/subaccount/services-upsert
// Phase A: accepts class definition fields (instructor_id, capacity, location,
//   drop_in_allowed, recurrence_rule, last_generated_through).
// Phase C.4: when a class type service is saved with a recurrence_rule and has
//   no existing future sessions, generates child class_sessions rows and
//   updates last_generated_through to today + 90 days.
//   Edit propagation (rule changes that delete/regenerate sessions) is C.5;
//   this Lambda does NOT regenerate when sessions already exist.

const crypto = require('crypto');
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const HORIZON_DAYS = 90;
const HARD_CAP_SESSIONS = 52;
const DEFAULT_OCCURRENCES = 12;

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const s = req.body || {};
  if (!s.id) return res.status(400).json({ error: 'id is required' });
  if (!s.name) return res.status(400).json({ error: 'name is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id FROM services WHERE id=$1 AND subaccount_id=$2',
      [s.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    // Compute last_generated_through up front. For class with recurrence,
    // set to horizon. Otherwise pass through whatever client provided (null).
    let lastGeneratedThrough = s.last_generated_through || null;
    if (s.type === 'class' && s.recurrence_rule) {
      lastGeneratedThrough = horizonDateStr();
    }

    await db.query(`
      INSERT INTO services (
        id, subaccount_id, name, description, category, type, color, price,
        buffer_before, buffer_after, assigned_staff, allow_client_choose_staff,
        availability, booking_lead_time_hours, booking_advance_days, active,
        instructor_id, capacity, location, drop_in_allowed,
        recurrence_rule, last_generated_through,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,
        NOW(),NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, description=EXCLUDED.description,
        category=EXCLUDED.category, type=EXCLUDED.type,
        color=EXCLUDED.color, price=EXCLUDED.price,
        buffer_before=EXCLUDED.buffer_before, buffer_after=EXCLUDED.buffer_after,
        assigned_staff=EXCLUDED.assigned_staff,
        allow_client_choose_staff=EXCLUDED.allow_client_choose_staff,
        availability=EXCLUDED.availability,
        booking_lead_time_hours=EXCLUDED.booking_lead_time_hours,
        booking_advance_days=EXCLUDED.booking_advance_days,
        active=EXCLUDED.active,
        instructor_id=EXCLUDED.instructor_id,
        capacity=EXCLUDED.capacity,
        location=EXCLUDED.location,
        drop_in_allowed=EXCLUDED.drop_in_allowed,
        recurrence_rule=EXCLUDED.recurrence_rule,
        last_generated_through=EXCLUDED.last_generated_through,
        updated_at=NOW()
      WHERE services.subaccount_id=$2
    `, [
      s.id, subaccountId, s.name, s.description||null, s.category||null,
      s.type||'individual', s.color||'#6b21ea',
      s.price!=null ? parseFloat(s.price) : null,
      parseInt(s.buffer_before)||0, parseInt(s.buffer_after)||0,
      JSON.stringify(s.assigned_staff||[]),
      s.allow_client_choose_staff !== false,
      JSON.stringify(s.availability||{}),
      parseInt(s.booking_lead_time_hours)||0,
      parseInt(s.booking_advance_days)||60,
      s.active !== false,
      s.instructor_id || null,
      s.capacity != null ? parseInt(s.capacity) : null,
      s.location || null,
      s.drop_in_allowed !== false,
      s.recurrence_rule ? JSON.stringify(s.recurrence_rule) : null,
      lastGeneratedThrough
    ]);

    // Generate sessions if class type with recurrence and no existing sessions.
    let generationResult = null;
    if (s.type === 'class' && s.recurrence_rule) {
      generationResult = await maybeGenerateSessions(s, subaccountId);
    }

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action: isNew ? 'subaccount.service.create' : 'subaccount.service.update',
      targetType:'service', targetId:s.id,
      targetSubaccountId:subaccountId,
      metadata: {
        name: s.name,
        type: s.type,
        has_recurrence: !!s.recurrence_rule,
        sessions_generated: generationResult ? generationResult.generated : 0,
        sessions_skipped_existing: generationResult ? generationResult.skipped : false
      }
    });

    return res.status(200).json({
      success: true,
      id: s.id,
      sessions_generated: generationResult ? generationResult.generated : 0,
      sessions_skipped_existing: generationResult ? generationResult.skipped : false
    });
  } catch(e) {
    console.error('services-upsert error:', e.message, e.stack);
    return res.status(500).json({ error:'Failed to save service' });
  }
}

// ===== Recurrence engine =====

// Returns { generated: N, skipped: bool }. Skipped=true means existing sessions were found.
async function maybeGenerateSessions(s, subaccountId) {
  // Skip if any future sessions already exist for this service. Edit propagation
  // is C.5 territory; this Lambda only auto-generates on first save.
  const today = todayStr();
  const existingSessions = await db.query(
    `SELECT id FROM class_sessions
     WHERE service_id=$1 AND subaccount_id=$2 AND date >= $3
     LIMIT 1`,
    [s.id, subaccountId, today]
  );
  if (existingSessions.rows.length > 0) {
    return { generated: 0, skipped: true };
  }

  const sessions = generateSessionsFromRule(s, s.recurrence_rule);
  if (!sessions.length) {
    return { generated: 0, skipped: false };
  }

  // Bulk INSERT. 14 parameters per row, plus participants literal and NOW().
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
    // subaccount_id pulled from outer auth context, not from session object
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

  return { generated: sessions.length, skipped: false };
}

// Generates session metadata objects from a recurrence rule. No DB writes.
function generateSessionsFromRule(service, rule) {
  if (!rule || !rule.start_date || !rule.start_time) return [];

  const sessions = [];
  const horizonStr = horizonDateStr();

  // Build session helper, captures common fields from service + rule.
  function buildSession(dateStr) {
    return {
      id: crypto.randomUUID(),
      subaccount_id: service.subaccount_id || null, // filled from caller context if missing
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

  // ONCE: single session, no end logic.
  if (rule.repeats === 'once') {
    sessions.push(buildSession(rule.start_date));
    return sessions;
  }

  // Determine occurrences cap and end-date cutoff.
  const endType = rule.end_type || 'never';
  let occurrencesCap = HARD_CAP_SESSIONS;
  if (endType === 'after') {
    occurrencesCap = Math.min(parseInt(rule.occurrences) || DEFAULT_OCCURRENCES, HARD_CAP_SESSIONS);
  }
  const endDateCutoff = (endType === 'on_date' && rule.end_date) ? rule.end_date : null;

  // Walk day-by-day from start_date emitting matching dates.
  // Stop conditions:
  //   - hard cap (HARD_CAP_SESSIONS) always applies, set via occurrencesCap
  //   - end_type='after': occurrencesCap honors user request up to hard cap
  //   - end_type='on_date': stop when cursor passes endDateCutoff
  //   - end_type='never': stop at horizon (so we don't generate sessions
  //     forever; cron extends later)
  // Horizon only applies when there's no explicit user-specified end.
  const useHorizon = (endType === 'never');
  const cursor = parseDateLocal(rule.start_date);
  if (!cursor) return [];

  // Safety: cap iterations to prevent infinite loops on bad input.
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

// ===== Date helpers =====

// Today in YYYY-MM-DD (UTC, server time. Acceptable for scheduling at day granularity).
function todayStr() {
  const d = new Date();
  return formatDateLocal(d);
}

// Horizon date (today + HORIZON_DAYS) in YYYY-MM-DD.
function horizonDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + HORIZON_DAYS);
  return formatDateLocal(d);
}

// Parse YYYY-MM-DD into a local-time Date at midnight. Avoids the TZ shift that
// `new Date('2026-05-04')` introduces (which interprets as UTC and can shift the day).
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

// Format a local-time Date as YYYY-MM-DD.
function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

exports.handler = wrap(handler);
