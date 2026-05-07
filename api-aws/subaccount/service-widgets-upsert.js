// POST /api/subaccount/service-widgets-upsert
// Creates or updates a single service_widgets row scoped to the caller's subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_STAFF_MODES   = ['specific', 'any', 'round_robin'];
const VALID_WIDGET_TYPES  = ['service', 'appointment', 'class'];
const VALID_PAYMENT_MODES = ['full', 'deposit', 'none'];
const VALID_DEPOSIT_TYPES = ['flat', 'percent'];

function toNullableInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function toIntWithDefault(v, def) {
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

function toBool(v, defaultValue) {
  if (v === undefined) return defaultValue;
  if (v === null || v === false || v === 'false' || v === 0 || v === '0') return false;
  return !!v;
}

function toNullableNumeric(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const w = req.body || {};

  if (!w.id || typeof w.id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!w.name || typeof w.name !== 'string' || !w.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  if (w.service_ids != null && !Array.isArray(w.service_ids)) {
    return res.status(400).json({ error: 'service_ids must be an array' });
  }
  if (w.staff_ids != null && !Array.isArray(w.staff_ids)) {
    return res.status(400).json({ error: 'staff_ids must be an array' });
  }
  if (w.staff_mode != null && !VALID_STAFF_MODES.includes(w.staff_mode)) {
    return res.status(400).json({ error: 'staff_mode must be specific, any, or round_robin' });
  }
  if (w.widget_type != null && !VALID_WIDGET_TYPES.includes(w.widget_type)) {
    return res.status(400).json({ error: 'widget_type must be service, appointment, or class' });
  }
  if (w.appointment_types != null && !Array.isArray(w.appointment_types)) {
    return res.status(400).json({ error: 'appointment_types must be an array' });
  }
  if (w.widget_availability != null && (typeof w.widget_availability !== 'object' || Array.isArray(w.widget_availability))) {
    return res.status(400).json({ error: 'widget_availability must be an object' });
  }

  if (w.payment_mode != null && !VALID_PAYMENT_MODES.includes(w.payment_mode)) {
    return res.status(400).json({ error: 'payment_mode must be full, deposit, or none' });
  }
  if (w.deposit_type != null && w.deposit_type !== '' && !VALID_DEPOSIT_TYPES.includes(w.deposit_type)) {
    return res.status(400).json({ error: 'deposit_type must be flat or percent' });
  }
  if (w.payment_mode === 'deposit' && (toNullableNumeric(w.deposit_value) == null || toNullableNumeric(w.deposit_value) <= 0)) {
    return res.status(400).json({ error: 'deposit_value must be > 0 when payment_mode is deposit' });
  }

  if (w.tip_percentages != null) {
    if (!Array.isArray(w.tip_percentages)) {
      return res.status(400).json({ error: 'tip_percentages must be an array' });
    }
    for (const p of w.tip_percentages) {
      const n = parseFloat(p);
      if (isNaN(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'tip_percentages entries must be 0-100' });
      }
    }
  }

  const cancelWindow = toIntWithDefault(w.cancel_window_hours, 24);
  if (cancelWindow < 0 || cancelWindow > 720) {
    return res.status(400).json({ error: 'cancel_window_hours must be 0-720' });
  }
  const reminderHours = toIntWithDefault(w.reminder_hours_before, 24);
  if (reminderHours < 1 || reminderHours > 168) {
    return res.status(400).json({ error: 'reminder_hours_before must be 1-168' });
  }
  const leadHours = toNullableInt(w.booking_lead_time_hours);
  if (leadHours != null && (leadHours < 0 || leadHours > 720)) {
    return res.status(400).json({ error: 'booking_lead_time_hours must be 0-720' });
  }
  const advanceDays = toNullableInt(w.booking_advance_days);
  if (advanceDays != null && (advanceDays < 0 || advanceDays > 365)) {
    return res.status(400).json({ error: 'booking_advance_days must be 0-365' });
  }

  if (w.widget_type === 'appointment' && Array.isArray(w.appointment_types)) {
    for (const t of w.appointment_types) {
      if (!t || typeof t !== 'object') {
        return res.status(400).json({ error: 'each appointment type must be an object' });
      }
      if (!t.id || typeof t.id !== 'string') {
        return res.status(400).json({ error: 'each appointment type must have an id' });
      }
      if (!t.name || typeof t.name !== 'string') {
        return res.status(400).json({ error: 'each appointment type must have a name' });
      }
      const dur = parseInt(t.duration);
      if (!dur || dur < 5) {
        return res.status(400).json({ error: 'each appointment type must have a duration of 5+ minutes' });
      }
    }
  }

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id, widget_type FROM service_widgets WHERE id = $1 AND subaccount_id = $2',
      [w.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    if (!isNew && w.widget_type && existing.rows[0].widget_type !== w.widget_type) {
      return res.status(400).json({
        error: 'widget_type cannot be changed after creation. Delete and recreate the widget.'
      });
    }
    const widgetType = isNew ? (w.widget_type || 'service') : existing.rows[0].widget_type;

    const params = [
      w.id,                                                       // $1
      subaccountId,                                               // $2
      w.name.trim(),                                              // $3
      widgetType,                                                 // $4
      JSON.stringify(w.service_ids || []),                        // $5
      w.primary_color || '#6b21ea',                               // $6
      w.logo_url || null,                                         // $7
      w.tagline || null,                                          // $8
      toBool(w.active, true),                                     // $9
      w.staff_mode || 'any',                                      // $10
      JSON.stringify(w.staff_ids || []),                          // $11
      JSON.stringify(w.round_robin_config || {}),                 // $12
      JSON.stringify(w.appointment_types || []),                  // $13
      JSON.stringify(w.widget_availability || {}),                // $14
      toBool(w.require_payment, false),                           // $15
      w.intake_form_id || null,                                   // $16
      w.confirm_message || null,                                  // $17
      w.payment_mode || 'full',                                   // $18
      w.deposit_type || null,                                     // $19
      toNullableNumeric(w.deposit_value),                         // $20
      toBool(w.allow_coupons, true),                              // $21
      toBool(w.allow_tip, false),                                 // $22
      JSON.stringify(w.tip_percentages || [10, 15, 20]),          // $23
      toBool(w.collect_phone, true),                              // $24
      toBool(w.collect_notes, true),                              // $25
      toBool(w.require_existing_patient, false),                  // $26
      toBool(w.allow_self_cancel, true),                          // $27
      cancelWindow,                                               // $28
      toBool(w.send_confirmation_email, true),                    // $29
      toBool(w.send_reminder_email, true),                        // $30
      reminderHours,                                              // $31
      toBool(w.send_reminder_sms, false),                         // $32
      leadHours,                                                  // $33
      advanceDays,                                                // $34
      toNullableInt(w.buffer_before_override),                    // $35
      toNullableInt(w.buffer_after_override),                     // $36
      w.custom_domain || null                                     // $37
    ];

    await db.query(`
      INSERT INTO service_widgets (
        id, subaccount_id, name, widget_type, service_ids, primary_color, logo_url, tagline, active,
        staff_mode, staff_ids, round_robin_config, appointment_types, widget_availability,
        require_payment, intake_form_id, confirm_message,
        payment_mode, deposit_type, deposit_value,
        allow_coupons, allow_tip, tip_percentages,
        collect_phone, collect_notes, require_existing_patient,
        allow_self_cancel, cancel_window_hours,
        send_confirmation_email, send_reminder_email, reminder_hours_before, send_reminder_sms,
        booking_lead_time_hours, booking_advance_days,
        buffer_before_override, buffer_after_override,
        custom_domain,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
        $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
        $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23::jsonb,
        $24, $25, $26,
        $27, $28,
        $29, $30, $31, $32,
        $33, $34,
        $35, $36,
        $37,
        NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        service_ids = EXCLUDED.service_ids,
        primary_color = EXCLUDED.primary_color,
        logo_url = EXCLUDED.logo_url,
        tagline = EXCLUDED.tagline,
        active = EXCLUDED.active,
        staff_mode = EXCLUDED.staff_mode,
        staff_ids = EXCLUDED.staff_ids,
        round_robin_config = EXCLUDED.round_robin_config,
        appointment_types = EXCLUDED.appointment_types,
        widget_availability = EXCLUDED.widget_availability,
        require_payment = EXCLUDED.require_payment,
        intake_form_id = EXCLUDED.intake_form_id,
        confirm_message = EXCLUDED.confirm_message,
        payment_mode = EXCLUDED.payment_mode,
        deposit_type = EXCLUDED.deposit_type,
        deposit_value = EXCLUDED.deposit_value,
        allow_coupons = EXCLUDED.allow_coupons,
        allow_tip = EXCLUDED.allow_tip,
        tip_percentages = EXCLUDED.tip_percentages,
        collect_phone = EXCLUDED.collect_phone,
        collect_notes = EXCLUDED.collect_notes,
        require_existing_patient = EXCLUDED.require_existing_patient,
        allow_self_cancel = EXCLUDED.allow_self_cancel,
        cancel_window_hours = EXCLUDED.cancel_window_hours,
        send_confirmation_email = EXCLUDED.send_confirmation_email,
        send_reminder_email = EXCLUDED.send_reminder_email,
        reminder_hours_before = EXCLUDED.reminder_hours_before,
        send_reminder_sms = EXCLUDED.send_reminder_sms,
        booking_lead_time_hours = EXCLUDED.booking_lead_time_hours,
        booking_advance_days = EXCLUDED.booking_advance_days,
        buffer_before_override = EXCLUDED.buffer_before_override,
        buffer_after_override = EXCLUDED.buffer_after_override,
        custom_domain = EXCLUDED.custom_domain,
        updated_at = NOW()
      WHERE service_widgets.subaccount_id = $2
    `, params);

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: isNew ? 'subaccount.service_widget.create' : 'subaccount.service_widget.update',
      targetType: 'service_widget', targetId: w.id,
      targetSubaccountId: subaccountId,
      metadata: {
        name: w.name,
        widget_type: widgetType,
        service_count: (w.service_ids || []).length,
        staff_mode: w.staff_mode || 'any',
        staff_count: (w.staff_ids || []).length,
        appointment_type_count: (w.appointment_types || []).length,
        require_payment: !!w.require_payment,
        payment_mode: w.payment_mode || 'full',
        active: w.active !== false
      }
    });

    const fresh = await db.query(
      'SELECT * FROM service_widgets WHERE id = $1 AND subaccount_id = $2',
      [w.id, subaccountId]
    );
    return res.status(200).json({ success: true, widget: fresh.rows[0] });
  } catch (e) {
    console.error('service-widgets-upsert error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to save widget' });
  }
}

exports.handler = wrap(handler);
