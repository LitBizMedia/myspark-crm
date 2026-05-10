// POST /api/subaccount/services-upsert
// Phase A: accepts class definition fields.
// Phase C.4: generates child class_sessions on first save when none exist.
// Phase C.5: detects rule changes vs existing recurrence_rule and propagates:
//   - Rule unchanged + non-rule fields changed: UPDATE future non-override sessions
//   - Rule changed, no rosters affected: DELETE future non-override sessions, regenerate
//   - Rule changed, rosters present, no force_regenerate flag: return 409 (block save)
//   - Rule changed, rosters present, force_regenerate=true: regenerate anyway

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
  const forceRegenerate = !!s.force_regenerate;

  try {
    // Load existing service row (if any) so we can compare rules.
    const existingResult = await db.query(
      'SELECT id, recurrence_rule FROM services WHERE id=$1 AND subaccount_id=$2',
      [s.id, subaccountId]
    );
    const oldService = existingResult.rows[0] || null;
    const isNew = !oldService;

    // Pre-check: if class with rule change and existing sessions have rosters,
    // block the save unless user confirmed force_regenerate.
    let ruleDidChange = false;
    if (s.type === 'class' && s.recurrence_rule && oldService) {
      const oldRule = parseRule(oldService.recurrence_rule);
      ruleDidChange = ruleChanged(oldRule, s.recurrence_rule);

      if (ruleDidChange && !forceRegenerate) {
        const rosterCheck = await countAffectedRosters(s.id, subaccountId);
        if (rosterCheck.affected > 0) {
          return res.status(409).json({
            error: 'roster_block',
            message: rosterCheck.affected + ' future session' + (rosterCheck.affected !== 1 ? 's have' : ' has') + ' enrolled participants. Confirm to delete and regenerate.',
            affected_sessions: rosterCheck.affected,
            enrolled_total: rosterCheck.enrolled
          });
        }
      }
    }

    // Validate group booking config (Stage 2)
    if (s.group_capable) {
      if (s.type !== 'individual') {
        return res.status(400).json({ error: 'Group booking only applies to Individual services' });
      }
      const sc = parseInt(s.group_staff_count);
      const smin = parseInt(s.group_size_min);
      const smax = parseInt(s.group_size_max);
      const assigned = Array.isArray(s.assigned_staff) ? s.assigned_staff : [];
      if (!sc || sc < 2) return res.status(400).json({ error: 'Group services need at least 2 staff' });
      if (!smin || smin < 1) return res.status(400).json({ error: 'Group size min must be at least 1' });
      if (!smax || smax < smin) return res.status(400).json({ error: 'Group size max must be at least min' });
      if (assigned.length < sc) return res.status(400).json({ error: 'Assigned staff list needs at least ' + sc + ' members for this group service' });
    }

    // Compute last_generated_through. Set to horizon for class+recurrence saves.
    let lastGeneratedThrough = s.last_generated_through || null;
    if (s.type === 'class' && s.recurrence_rule) {
      lastGeneratedThrough = horizonDateStr();
    }

    // UPSERT service row. Past this point we are committed to the save.
    await db.query(`
      INSERT INTO services (
        id, subaccount_id, name, description, category, type, color, price,
        buffer_before, buffer_after, assigned_staff, allow_client_choose_staff,
        booking_lead_time_hours, booking_advance_days, active,
        instructor_id, capacity, location, drop_in_allowed,
        recurrence_rule, last_generated_through, taxable,
        group_capable, group_staff_count,
        group_size_min, group_size_max,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26,
        NOW(),NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, description=EXCLUDED.description,
        category=EXCLUDED.category, type=EXCLUDED.type,
        color=EXCLUDED.color, price=EXCLUDED.price,
        buffer_before=EXCLUDED.buffer_before, buffer_after=EXCLUDED.buffer_after,
        assigned_staff=EXCLUDED.assigned_staff,
        allow_client_choose_staff=EXCLUDED.allow_client_choose_staff,
        booking_lead_time_hours=EXCLUDED.booking_lead_time_hours,
        booking_advance_days=EXCLUDED.booking_advance_days,
        active=EXCLUDED.active,
        instructor_id=EXCLUDED.instructor_id,
        capacity=EXCLUDED.capacity,
        location=EXCLUDED.location,
        drop_in_allowed=EXCLUDED.drop_in_allowed,
        recurrence_rule=EXCLUDED.recurrence_rule,
        last_generated_through=EXCLUDED.last_generated_through,
        taxable=EXCLUDED.taxable,
        group_capable=EXCLUDED.group_capable,
        group_staff_count=EXCLUDED.group_staff_count,
        group_size_min=EXCLUDED.group_size_min,
        group_size_max=EXCLUDED.group_size_max,
        updated_at=NOW()
      WHERE services.subaccount_id=$2
    `, [
      s.id, subaccountId, s.name, s.description||null, s.category||null,
      s.type||'individual', s.color||'#6b21ea',
      s.price!=null ? parseFloat(s.price) : null,
      parseInt(s.buffer_before)||0, parseInt(s.buffer_after)||0,
      JSON.stringify(s.assigned_staff||[]),
      s.allow_client_choose_staff !== false,
      parseInt(s.booking_lead_time_hours)||0,
      parseInt(s.booking_advance_days)||60,
      s.active !== false,
      s.instructor_id || null,
      s.capacity != null ? parseInt(s.capacity) : null,
      s.location || null,
      s.drop_in_allowed !== false,
      s.recurrence_rule ? JSON.stringify(s.recurrence_rule) : null,
      lastGeneratedThrough,
      s.taxable !== false,
      // Group booking config (Stage 2 of group feature)
      !!s.group_capable,
      s.group_capable && s.group_staff_count != null ? parseInt(s.group_staff_count) : null,
      s.group_capable && s.group_size_min != null ? parseInt(s.group_size_min) : null,
      s.group_capable && s.group_size_max != null ? parseInt(s.group_size_max) : null
    ]);

    // Class session handling: generate, regenerate, or propagate.
    let sessionResult = { generated: 0, deleted: 0, updated: 0, skipped: false };
    if (s.type === 'class' && s.recurrence_rule) {
      sessionResult = await handleClassSessions(s, subaccountId, ruleDidChange, !!oldService);
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
        rule_changed: ruleDidChange,
        force_regenerate: forceRegenerate,
        sessions_generated: sessionResult.generated,
        sessions_deleted: sessionResult.deleted,
        sessions_updated: sessionResult.updated
      }
    });

    return res.status(200).json({
      success: true,
      id: s.id,
      sessions_generated: sessionResult.generated,
      sessions_deleted: sessionResult.deleted,
      sessions_updated: sessionResult.updated,
      rule_changed: ruleDidChange
    });
  } catch(e) {
    console.error('services-upsert error:', e.message, e.stack);
    return res.status(500).json({ error:'Failed to save service' });
  }
}

// ===== Class session handling =====

async function handleClassSessions(s, subaccountId, ruleDidChange, isExistingService) {
  const today = todayStr();

  // Find future sessions for this service (any status except already cancelled).
  const futureResult = await db.query(
    `SELECT id, is_override FROM class_sessions
     WHERE service_id=$1 AND subaccount_id=$2 AND date >= $3 AND status != 'cancelled'`,
    [s.id, subaccountId, today]
  );
  const futureSessions = futureResult.rows;

  // Case 1: New class or no existing future sessions. Generate fresh.
  if (!isExistingService || futureSessions.length === 0) {
    const sessions = generateSessionsFromRule(s, s.recurrence_rule);
    if (sessions.length) await bulkInsertSessions(sessions, subaccountId);
    return { generated: sessions.length, deleted: 0, updated: 0, skipped: false };
  }

  // Case 2: Rule changed. Pre-check already passed (rosters cleared or forced).
  // Delete future non-override sessions and regenerate.
  if (ruleDidChange) {
    const deleteResult = await db.query(
      `DELETE FROM class_sessions
       WHERE service_id=$1 AND subaccount_id=$2 AND date >= $3 AND is_override = false`,
      [s.id, subaccountId, today]
    );
    const sessions = generateSessionsFromRule(s, s.recurrence_rule);
    if (sessions.length) await bulkInsertSessions(sessions, subaccountId);
    return {
      generated: sessions.length,
      deleted: deleteResult.rowCount || 0,
      updated: 0,
      skipped: false
    };
  }

  // Case 3: Rule unchanged. Propagate non-rule field changes to future
  // non-override sessions.
  const updateResult = await db.query(
    `UPDATE class_sessions
     SET instructor_id=$1, capacity=$2, location=$3, duration=$4, price=$5,
         title=$6, updated_at=NOW()
     WHERE service_id=$7 AND subaccount_id=$8 AND date >= $9
       AND is_override = false AND status != 'cancelled'`,
    [
      s.instructor_id || null,
      parseInt(s.capacity) || 10,
      s.location || null,
      parseInt(s.duration_default) || 60,
      s.price != null ? parseFloat(s.price) : null,
      s.name,
      s.id, subaccountId, today
    ]
  );
  return { generated: 0, deleted: 0, updated: updateResult.rowCount || 0, skipped: false };
}

// Counts future non-override sessions with at least one enrolled participant.
async function countAffectedRosters(serviceId, subaccountId) {
  const today = todayStr();
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS affected,
       COALESCE(SUM((
         SELECT COUNT(*) FROM jsonb_array_elements(participants) p
         WHERE p->>'status' = 'enrolled'
       )), 0)::int AS enrolled
     FROM class_sessions
     WHERE service_id=$1 AND subaccount_id=$2 AND date >= $3
       AND is_override = false AND status != 'cancelled'
       AND participants IS NOT NULL
       AND jsonb_typeof(participants) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(participants) p
         WHERE p->>'status' = 'enrolled'
       )`,
    [serviceId, subaccountId, today]
  );
  return {
    affected: result.rows[0].affected || 0,
    enrolled: result.rows[0].enrolled || 0
  };
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

// ===== Bulk insert =====

async function bulkInsertSessions(sessions, subaccountId) {
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

exports.handler = wrap(handler);
