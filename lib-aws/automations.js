// lib/automations.js
// Automation engine for MySpark+.
//
// Fires actions when triggers match. Idempotency enforced via
// automation_runs unique constraint on (automation_id, contact_id, target_ref).
//
// Design:
//   - Never throws. Failures log to console and to automation_runs.
//   - Event-based triggers call fireAutomationTriggersAsync from event Lambdas (fire-and-forget).
//   - Time-based triggers run from a daily cron Lambda (session 3).
//   - Consent and suppression honored in action handlers, not here.
//
// Idempotency model: claim slot first (INSERT ON CONFLICT DO NOTHING),
// then run action and update status. Failed runs do not auto-retry in v1.

const db = require('./db');
const { runAction } = require('./automation-actions');
const { buildVarsForContext } = require('./automation-vars');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function slugFromSubaccountId(subaccountId) {
  return subaccountId.replace(/^sub-/, '');
}

// Compute target_ref for idempotency lookups.
// Different triggers have different "unit of work" they fire against.
function computeTargetRef(automation, context) {
  const triggerType = automation.trigger_type;
  const rule = automation.idempotency_rule;
  const now = new Date();

  if (rule === 'once_ever') return 'ever';

  if (rule === 'once_per_year') return 'year_' + now.getUTCFullYear();

  if (rule === 'once_per_period') {
    const days = automation.idempotency_window_days || 30;
    const period = Math.floor(Date.now() / (days * 86400 * 1000));
    return 'period_' + days + '_' + period;
  }

  // once_per_target: tie to the event's natural unit
  if (triggerType === 'appointment_booked' ||
      triggerType === 'appointment_status_changed' ||
      triggerType === 'days_before_appointment' ||
      triggerType === 'days_after_appointment') {
    return 'appt_' + (context.appointmentId || '');
  }
  if (triggerType === 'payment_received') {
    return 'pay_' + (context.paymentId || '');
  }
  if (triggerType === 'form_submitted') {
    return 'form_' + (context.formSubmissionId || '');
  }
  if (triggerType === 'class_registration_completed') {
    return 'class_' + (context.classSessionId || '');
  }
  if (triggerType === 'contact_tagged') {
    return 'tag_' + (context.tag || '');
  }
  return 'contact';
}

function triggerMatches(automation, context) {
  const cfg = automation.trigger_config || {};
  const t = automation.trigger_type;

  if (t === 'appointment_booked') {
    if (cfg.service_id && cfg.service_id !== context.serviceId) return false;
    if (cfg.appointment_type_id && cfg.appointment_type_id !== context.appointmentTypeId) return false;
    if (cfg.only_first_booking && !context.isFirstBooking) return false;
    return true;
  }
  if (t === 'appointment_status_changed') {
    if (cfg.to_status && cfg.to_status !== context.newStatus) return false;
    if (cfg.from_status && cfg.from_status !== context.oldStatus) return false;
    return true;
  }
  if (t === 'payment_received') {
    if (cfg.min_amount && (context.amount || 0) < cfg.min_amount) return false;
    return true;
  }
  if (t === 'form_submitted') {
    if (cfg.form_id && cfg.form_id !== context.formId) return false;
    return true;
  }
  if (t === 'class_registration_completed') {
    if (cfg.class_service_id && cfg.class_service_id !== context.classServiceId) return false;
    return true;
  }
  if (t === 'contact_tagged') {
    if (cfg.tag && cfg.tag !== context.tag) return false;
    return true;
  }
  return true;
}

// Main entry. Never throws. Errors recorded in automation_runs, never propagated.
async function fireAutomationTriggers(triggerType, context) {
  try {
    const { subaccountId, contactId } = context;
    if (!subaccountId || !contactId) return;

    const r = await db.query(
      'SELECT * FROM automations WHERE subaccount_id = $1 AND trigger_type = $2 AND active = true',
      [subaccountId, triggerType]
    );

    for (const automation of r.rows) {
      if (!triggerMatches(automation, context)) continue;

      const targetRef = computeTargetRef(automation, context);
      const runId = uid();

      // Claim the idempotency slot first
      const insertResult = await db.query(
        'INSERT INTO automation_runs (id, automation_id, subaccount_id, contact_id, target_ref, ran_at, status, metadata) ' +
        "VALUES ($1, $2, $3, $4, $5, NOW(), 'success', $6) " +
        'ON CONFLICT (automation_id, contact_id, target_ref) DO NOTHING RETURNING id',
        [
          runId,
          automation.id,
          subaccountId,
          contactId,
          targetRef,
          JSON.stringify({ trigger_type: triggerType, context_keys: Object.keys(context) })
        ]
      );

      if (insertResult.rowCount === 0) continue;

      try {
        const slug = slugFromSubaccountId(subaccountId);
        const vars = await buildVarsForContext(triggerType, context, subaccountId);
        const result = await runAction(automation, contactId, subaccountId, slug, vars);

        if (result.status !== 'success') {
          await db.query(
            'UPDATE automation_runs SET status = $1, error_message = $2 WHERE id = $3',
            [result.status, result.error || null, runId]
          );
        } else {
          await db.query(
            'UPDATE automations SET total_runs = total_runs + 1, last_ran_at = NOW() WHERE id = $1',
            [automation.id]
          );
        }
      } catch (actionErr) {
        await db.query(
          "UPDATE automation_runs SET status = 'failed', error_message = $1 WHERE id = $2",
          [String(actionErr && actionErr.message || actionErr), runId]
        );
        console.error('Automation action error:', automation.id, actionErr);
      }
    }
  } catch (e) {
    console.error('fireAutomationTriggers error:', e);
  }
}

// Fire-and-forget wrapper for event Lambdas where response latency matters.
function fireAutomationTriggersAsync(triggerType, context) {
  fireAutomationTriggers(triggerType, context).catch(e => {
    console.error('fireAutomationTriggersAsync uncaught:', e);
  });
}

// Manual fire for the dashboard "test send" feature.
// Bypasses idempotency, uses minimal context.
async function testFireAutomation(automationId, contactId) {
  try {
    const r = await db.query('SELECT * FROM automations WHERE id = $1', [automationId]);
    if (r.rows.length === 0) return { status: 'failed', error: 'Automation not found' };
    const automation = r.rows[0];

    const slug = slugFromSubaccountId(automation.subaccount_id);
    const context = { subaccountId: automation.subaccount_id, contactId, isTest: true };
    const vars = await buildVarsForContext(automation.trigger_type, context, automation.subaccount_id);
    return await runAction(automation, contactId, automation.subaccount_id, slug, vars);
  } catch (e) {
    return { status: 'failed', error: String(e && e.message || e) };
  }
}

module.exports = {
  fireAutomationTriggers,
  fireAutomationTriggersAsync,
  testFireAutomation
};
