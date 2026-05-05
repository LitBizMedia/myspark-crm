// POST /api/subaccount/service-widgets-upsert
// Creates or updates a single service_widgets row scoped to the caller's subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_STAFF_MODES = ['specific', 'any', 'round_robin'];
const VALID_WIDGET_TYPES = ['service', 'appointment', 'class'];

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

  // For appointment widgets, validate appointment_types shape
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

  // widget_type is locked after creation. Once a widget exists with a type, we
  // do not allow changing it (would break the consistency of associated bookings).
  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      'SELECT id, widget_type FROM service_widgets WHERE id = $1 AND subaccount_id = $2',
      [w.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    // widget_type is immutable. Reject attempts to change it on an existing widget.
    if (!isNew && w.widget_type && existing.rows[0].widget_type !== w.widget_type) {
      return res.status(400).json({
        error: 'widget_type cannot be changed after creation. Delete and recreate the widget.'
      });
    }
    // For new widgets, default widget_type to 'service' if not specified.
    const widgetType = isNew
      ? (w.widget_type || 'service')
      : existing.rows[0].widget_type;

    await db.query(`
      INSERT INTO service_widgets (
        id, subaccount_id, name, widget_type, service_ids, primary_color, logo_url, tagline, active,
        staff_mode, staff_ids, round_robin_config, appointment_types,
        require_payment, intake_form_id, confirm_message,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
        $10, $11::jsonb, $12::jsonb, $13::jsonb,
        $14, $15, $16,
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
        require_payment = EXCLUDED.require_payment,
        intake_form_id = EXCLUDED.intake_form_id,
        confirm_message = EXCLUDED.confirm_message,
        updated_at = NOW()
      WHERE service_widgets.subaccount_id = $2
    `, [
      w.id, subaccountId, w.name.trim(), widgetType,
      JSON.stringify(w.service_ids || []),
      w.primary_color || '#6b21ea',
      w.logo_url || null,
      w.tagline || null,
      w.active !== false,
      w.staff_mode || 'any',
      JSON.stringify(w.staff_ids || []),
      JSON.stringify(w.round_robin_config || {}),
      JSON.stringify(w.appointment_types || []),
      !!w.require_payment,
      w.intake_form_id || null,
      w.confirm_message || null
    ]);

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
