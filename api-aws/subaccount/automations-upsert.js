// POST /api/subaccount/automations-upsert
// Create or update an automation for the authed subaccount.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function uid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

const VALID_TRIGGERS = new Set([
  'contact_birthday', 'contact_age_days',
  'days_before_appointment', 'days_after_appointment',
  'days_after_first_booking', 'days_after_last_booking',
  'contact_created', 'contact_tagged',
  'appointment_booked', 'appointment_status_changed',
  'payment_received', 'form_submitted', 'class_registration_completed'
]);

const VALID_ACTIONS = new Set(['send_email', 'send_sms', 'add_tag', 'remove_tag']);

const VALID_IDEMPOTENCY = new Set([
  'once_ever', 'once_per_target', 'once_per_year', 'once_per_period'
]);

function validate(body) {
  const errors = [];
  if (!body.name || !String(body.name).trim()) errors.push('name is required');
  if (!body.trigger_type || !VALID_TRIGGERS.has(body.trigger_type)) errors.push('valid trigger_type is required');
  if (!body.action_type || !VALID_ACTIONS.has(body.action_type)) errors.push('valid action_type is required');
  if (!body.idempotency_rule || !VALID_IDEMPOTENCY.has(body.idempotency_rule)) {
    errors.push('valid idempotency_rule is required');
  }
  if (body.idempotency_rule === 'once_per_period') {
    const w = parseInt(body.idempotency_window_days, 10);
    if (!w || w < 1) errors.push('idempotency_window_days is required for once_per_period');
  }

  const cfg = body.action_config || {};
  if (body.action_type === 'send_email') {
    if (!cfg.subject || !String(cfg.subject).trim()) errors.push('action_config.subject is required for send_email');
    if (!cfg.body_html || !String(cfg.body_html).trim()) errors.push('action_config.body_html is required for send_email');
  }
  if (body.action_type === 'send_sms') {
    if (!cfg.body || !String(cfg.body).trim()) errors.push('action_config.body is required for send_sms');
  }
  if (body.action_type === 'add_tag' || body.action_type === 'remove_tag') {
    if (!cfg.tag || !String(cfg.tag).trim()) errors.push('action_config.tag is required for tag actions');
  }

  const tcfg = body.trigger_config || {};
  if (body.trigger_type === 'contact_age_days' ||
      body.trigger_type === 'days_after_appointment' ||
      body.trigger_type === 'days_after_first_booking' ||
      body.trigger_type === 'days_after_last_booking') {
    const d = parseInt(tcfg.days_after, 10);
    if (isNaN(d) || d < 0) errors.push('trigger_config.days_after is required for ' + body.trigger_type);
  }
  if (body.trigger_type === 'days_before_appointment') {
    const d = parseInt(tcfg.days_before, 10);
    if (isNaN(d) || d < 0) errors.push('trigger_config.days_before is required for days_before_appointment');
  }
  return errors;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const errors = validate(b);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const isUpdate = !!b.id;
    const id = b.id || uid();
    const name = String(b.name).trim();
    const description = b.description ? String(b.description).trim() : null;
    const active = b.active !== false;
    const triggerType = b.trigger_type;
    const triggerConfig = b.trigger_config || {};
    const actionType = b.action_type;
    const actionConfig = b.action_config || {};
    const idempotencyRule = b.idempotency_rule;
    const idempotencyWindowDays = b.idempotency_window_days || null;
    const isTransactional = !!b.is_transactional;

    if (isUpdate) {
      const existing = await db.query(
        'SELECT id FROM automations WHERE id = $1 AND subaccount_id = $2',
        [id, auth.subaccount_id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'Automation not found' });
    }

    await db.query(
      'INSERT INTO automations (id, subaccount_id, name, description, active, trigger_type, trigger_config, action_type, action_config, idempotency_rule, idempotency_window_days, is_transactional, created_by, updated_by) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $13) ' +
      'ON CONFLICT (id) DO UPDATE SET ' +
      '  name = EXCLUDED.name, description = EXCLUDED.description, active = EXCLUDED.active, ' +
      '  trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, ' +
      '  action_type = EXCLUDED.action_type, action_config = EXCLUDED.action_config, ' +
      '  idempotency_rule = EXCLUDED.idempotency_rule, idempotency_window_days = EXCLUDED.idempotency_window_days, ' +
      '  is_transactional = EXCLUDED.is_transactional, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
      [
        id, auth.subaccount_id, name, description, active,
        triggerType, JSON.stringify(triggerConfig),
        actionType, JSON.stringify(actionConfig),
        idempotencyRule, idempotencyWindowDays, isTransactional,
        auth.user_id
      ]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isUpdate ? 'subaccount.automation.update' : 'subaccount.automation.create',
      targetType: 'automation',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name, trigger_type: triggerType, action_type: actionType, active }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('automations-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save automation' });
  }
}

exports.handler = wrap(handler);
