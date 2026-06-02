// POST /api/subaccount/services-upsert
// Phase A: accepts class definition fields.
// Phase C.4: generates child class_sessions on first save when none exist.
// Phase C.5: detects rule changes vs existing recurrence_rule and propagates:
//   - Rule unchanged + non-rule fields changed: UPDATE future non-override sessions
//   - Rule changed, no rosters affected: DELETE future non-override sessions, regenerate
//   - Rule changed, rosters present, no force_regenerate flag: return 409 (block save)
//   - Rule changed, rosters present, force_regenerate=true: regenerate anyway

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const classSessions = require('./lib/class-sessions');
const {
  HORIZON_DAYS, HARD_CAP_SESSIONS, DEFAULT_OCCURRENCES,
  todayStr, horizonDateStr, parseDateLocal, formatDateLocal,
  parseRule, ruleChanged, generateSessionsFromRule
} = classSessions;

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
        availability,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26,
        $27,
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
        availability=EXCLUDED.availability,
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
      true, // drop_in_allowed inert: classes always per-session. Column dropped in later migration.
      s.recurrence_rule ? JSON.stringify(s.recurrence_rule) : null,
      lastGeneratedThrough,
      s.taxable !== false,
      // Group booking config (Stage 2 of group feature)
      !!s.group_capable,
      s.group_capable && s.group_staff_count != null ? parseInt(s.group_staff_count) : null,
      s.group_capable && s.group_size_min != null ? parseInt(s.group_size_min) : null,
      s.group_capable && s.group_size_max != null ? parseInt(s.group_size_max) : null,
      // Per-service availability JSONB. null when service uses business hours.
      s.availability ? JSON.stringify(s.availability) : null
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
    if (sessions.length) await classSessions.bulkInsertSessions(db, sessions, subaccountId);
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
    if (sessions.length) await classSessions.bulkInsertSessions(db, sessions, subaccountId);
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

// ===== Bulk insert =====

// ===== Recurrence engine =====

// ===== Date helpers =====

exports.handler = wrap(handler);
