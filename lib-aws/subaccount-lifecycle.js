// lib/subaccount-lifecycle.js
//
// Shared subaccount deletion logic used by:
//   - api/agency/delete-subaccount.js (manual delete from agency dashboard)
//   - api/cron/run-billing.js (30-day auto-delete after cancellation)
//
// Single source of truth so the two paths can never drift.
//
// Order of operations (hard delete, irreversible):
//   1. Load subaccount + plan + email domain + sms settings (snapshot for audit)
//   2. Check protected_from_deletion flag - refuse with 'denied' audit if set
//   3. Write audit log entry FIRST with full snapshot (before any data destroyed)
//   4. Disable Square card on file (best effort)
//   5. Disable customer Square cards (saved cards in subaccount's contact records, best effort)
//   6. Release Twilio number (best effort)
//   7. Remove Mailgun domain (best effort)
//   8. DELETE from non-cascading tables explicitly
//   9. DELETE from subaccounts row (CASCADE handles 8 properly-FK'd tables)
//   10. Write follow-up audit log with cleanup_results
//
// audit_log entries persist across subaccount deletion (HIPAA 6-year retention).
//
// MIGRATED: Supabase REST → lib/db.js for all DB operations.
// External APIs (Square via agency-billing, Twilio direct, Mailgun via Secrets Manager) unchanged.

const db = require('./db');
const secrets = require('./secrets');
const { logAudit } = require('./audit');
const { agencySquareCall } = require('./agency-billing');
const { getAllContacts } = require('./contacts');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

// Tables that have NO foreign-key cascade. Must be deleted explicitly.
// Note: conversations + conversation_messages CASCADE via FK on subaccount_id.
// agency_email_log is intentionally NOT deleted (cross-subaccount agency record retention).
const NON_CASCADING_TABLES = [
  { table: 'appointments',              column: 'subaccount_id' },
  { table: 'appointment_reminders',     column: 'subaccount_id' },
  { table: 'email_templates',           column: 'subaccount_id' },
  { table: 'failed_login_attempts',     column: 'subaccount_id' },
  { table: 'sessions',                  column: 'subaccount_id' },
  { table: 'sms_registration_requests', column: 'subaccount_id' },
  { table: 'sms_settings',              column: 'subaccount_id' },
  { table: 'subaccount_email_domains',  column: 'subaccount_id' }
];

async function deleteSubaccount(subaccountId, opts) {
  opts = opts || {};
  const actor = opts.actor || {};
  const actionName = opts.actionName || 'agency.subaccount.delete';
  const reason = opts.reason || 'manual';
  const req = opts.req || { headers: {} };

  // ── Step 1: Load subaccount snapshot ──
  let sub;
  try {
    sub = await db.findOne('subaccounts', { id: subaccountId });
  } catch (err) {
    return { success: false, error: 'Failed to load subaccount: ' + err.message, code: 'LOAD_FAILED' };
  }
  
  if (!sub) {
    await logAudit({
      req, ...actor,
      action: actionName,
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: 'Subaccount not found',
      metadata: { reason: reason }
    });
    return { success: false, error: 'Subaccount not found', code: 'NOT_FOUND' };
  }

  // ── Step 2: Protected check ──
  if (sub.protected_from_deletion) {
    await logAudit({
      req, ...actor,
      action: actionName,
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'denied',
      errorMessage: 'protected_from_deletion is true',
      metadata: {
        reason: reason,
        subaccount_name: sub.name,
        subaccount_slug: sub.slug
      }
    });
    return { success: false, error: 'This subaccount is protected from deletion.', code: 'PROTECTED' };
  }

  // ── Load plan, email domain, sms settings, and subaccount_data for snapshot ──
  let plan = null;
  try {
    plan = await db.findOne('subaccount_plans', { subaccount_id: subaccountId });
  } catch (e) { /* swallow */ }

  let emailDomain = null;
  try {
    emailDomain = await db.findOne('subaccount_email_domains', { subaccount_id: subaccountId });
  } catch (e) { /* swallow */ }

  let smsSettings = null;
  try {
    smsSettings = await db.findOne('sms_settings', { subaccount_id: subaccountId });
  } catch (e) { /* swallow */ }

  let subaccountData = null;
  try {
    subaccountData = await db.findOne('subaccount_data', { subaccount_id: subaccountId });
  } catch (e) { /* swallow */ }

  // ── Step 3: Write audit log entry FIRST, before destruction ──
  const cleanupResults = {
    square_billing_card_disabled:   null,
    square_customer_cards_disabled: null,
    twilio_released:                null,
    mailgun_removed:                null,
    rows_deleted:                   {}
  };

  await logAudit({
    req, ...actor,
    action: actionName,
    targetType: 'subaccount',
    targetId: subaccountId,
    targetSubaccountId: subaccountId,
    metadata: {
      reason: reason,
      subaccount_name:     sub.name,
      subaccount_slug:     sub.slug,
      admin_email:         sub.admin_email,
      had_plan:            !!plan,
      plan_tier:           plan && plan.plan_tier,
      plan_status:         plan && plan.status,
      had_hipaa_addon:     plan && !!plan.hipaa_addon,
      square_customer_id:  plan && plan.square_customer_id,
      square_card_id:      plan && plan.square_card_id,
      had_email_domain:    !!emailDomain,
      email_domain_name:   emailDomain && emailDomain.domain_name,
      mailgun_domain:      emailDomain && emailDomain.domain,
      had_sms_settings:    !!smsSettings,
      twilio_number:       smsSettings && smsSettings.twilio_phone_number,
      twilio_number_sid:   smsSettings && smsSettings.twilio_number_sid,
      cleanup_pending:     true
    }
  });

  // ── Step 4: Disable Square billing card (best effort) ──
  if (plan && plan.square_card_id) {
    try {
      await agencySquareCall('POST', '/v2/cards/' + plan.square_card_id + '/disable', null);
      cleanupResults.square_billing_card_disabled = true;
    } catch (e) {
      cleanupResults.square_billing_card_disabled = false;
      console.error('deleteSubaccount: Square billing card disable failed for ' + subaccountId + ':', e.message);
    }
  } else {
    cleanupResults.square_billing_card_disabled = 'no_card_on_file';
  }

  // ── Step 5: Disable customer Square cards ──
  try {
    let totalCards = 0;
    let disabledCards = 0;
    {
      const contacts = await getAllContacts(subaccountId);
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        const cards = (c && c.squareCards) || [];
        for (let j = 0; j < cards.length; j++) {
          const cardId = cards[j] && cards[j].id;
          if (!cardId) continue;
          totalCards++;
          try {
            await agencySquareCall('POST', '/v2/cards/' + cardId + '/disable', null);
            disabledCards++;
          } catch (e) {
            console.error('deleteSubaccount: customer card disable failed for ' + cardId + ':', e.message);
          }
        }
      }
    }
    cleanupResults.square_customer_cards_disabled = {
      total_found: totalCards,
      disabled:    disabledCards,
      failed:      totalCards - disabledCards
    };
  } catch (e) {
    cleanupResults.square_customer_cards_disabled = { error: e.message };
    console.error('deleteSubaccount: customer cards iteration failed:', e.message);
  }

  // ── Step 6: Release Twilio number (best effort, external API) ──
  if (smsSettings && smsSettings.twilio_number_sid) {
    try {
      const auth = Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
      const twilioRes = await fetch(
        'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/IncomingPhoneNumbers/' + smsSettings.twilio_number_sid + '.json',
        { method: 'DELETE', headers: { 'Authorization': 'Basic ' + auth } }
      );
      cleanupResults.twilio_released = twilioRes.ok;
      if (!twilioRes.ok) {
        console.error('deleteSubaccount: Twilio release failed:', await twilioRes.text());
      }
    } catch (e) {
      cleanupResults.twilio_released = false;
      console.error('deleteSubaccount: Twilio release threw:', e.message);
    }
  } else {
    cleanupResults.twilio_released = 'no_number_to_release';
  }

  // ── Step 7: Remove Mailgun domain (best effort, external API) ──
  if (emailDomain && emailDomain.domain) {
    try {
      const mgKey = await secrets.getKey(
        'myspark/integrations/mailgun',
        'MAILGUN_ACCOUNT_API_KEY'
      );
      const apiBase = 'https://api.mailgun.net/v4';
      const auth = Buffer.from('api:' + mgKey).toString('base64');
      const mgRes = await fetch(
        apiBase + '/domains/' + encodeURIComponent(emailDomain.domain),
        { method: 'DELETE', headers: { 'Authorization': 'Basic ' + auth } }
      );
      cleanupResults.mailgun_removed = mgRes.ok;
      if (!mgRes.ok) {
        console.error('deleteSubaccount: Mailgun domain remove failed:', await mgRes.text());
      }
    } catch (e) {
      cleanupResults.mailgun_removed = false;
      console.error('deleteSubaccount: Mailgun remove threw:', e.message);
    }
  } else {
    cleanupResults.mailgun_removed = 'no_domain_to_remove';
  }

  // ── Step 8: Delete from non-cascading tables explicitly ──
  for (let i = 0; i < NON_CASCADING_TABLES.length; i++) {
    const t = NON_CASCADING_TABLES[i];
    try {
      const deleted = await db.deleteWhere(t.table, { [t.column]: subaccountId });
      cleanupResults.rows_deleted[t.table] = 'ok (' + deleted.length + ' rows)';
    } catch (e) {
      cleanupResults.rows_deleted[t.table] = 'error: ' + e.message;
      console.error('deleteSubaccount: delete from ' + t.table + ' threw:', e.message);
    }
  }

  // Special case: password_reset_tokens uses subaccount_slug, not subaccount_id
  if (sub.slug) {
    try {
      const deleted = await db.deleteWhere('password_reset_tokens', { subaccount_slug: sub.slug });
      cleanupResults.rows_deleted.password_reset_tokens = 'ok (' + deleted.length + ' rows)';
    } catch (e) {
      cleanupResults.rows_deleted.password_reset_tokens = 'error: ' + e.message;
    }
  }

  // ── Step 9: Final delete - subaccounts row (CASCADE handles the FK'd tables) ──
  try {
    await db.deleteWhere('subaccounts', { id: subaccountId });
  } catch (err) {
    await logAudit({
      req, ...actor,
      action: actionName,
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: 'Final delete failed: ' + err.message,
      metadata: { reason: reason, cleanup_results: cleanupResults }
    });
    return { success: false, error: 'Final delete failed: ' + err.message, code: 'DELETE_FAILED', cleanup_results: cleanupResults };
  }

  // ── Step 10: Write completion audit log ──
  const externalFailures = (
    cleanupResults.square_billing_card_disabled === false ||
    cleanupResults.twilio_released === false ||
    cleanupResults.mailgun_removed === false ||
    (cleanupResults.square_customer_cards_disabled && cleanupResults.square_customer_cards_disabled.failed > 0)
  );

  await logAudit({
    req, ...actor,
    action: (actionName === 'system.subaccount.auto_delete')
      ? 'system.subaccount.auto_delete_complete'
      : 'agency.subaccount.delete_complete',
    targetType: 'subaccount',
    targetId: subaccountId,
    targetSubaccountId: subaccountId,
    outcome: externalFailures ? 'failure' : 'success',
    errorMessage: externalFailures ? 'One or more external cleanup steps failed' : null,
    metadata: {
      reason: reason,
      subaccount_name: sub.name,
      subaccount_slug: sub.slug,
      cleanup_results: cleanupResults
    }
  });

  return {
    success: true,
    partial: externalFailures,
    cleanup_results: cleanupResults
  };
}

module.exports = {
  deleteSubaccount,
  NON_CASCADING_TABLES
};
