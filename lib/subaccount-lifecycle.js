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
//   7. Remove Resend domain (best effort)
//   8. DELETE from non-cascading tables explicitly
//   9. DELETE from subaccounts row (CASCADE handles 8 properly-FK'd tables)
//   10. Write follow-up audit log with cleanup_results
//
// audit_log entries persist across subaccount deletion (HIPAA 6-year retention).
//
// Returns { success: true, cleanup_results } on full success or
// { success: true, partial: true, cleanup_results } if external cleanup
// had failures but the database delete completed. Returns
// { success: false, error, code } on database delete failure.

const { logAudit } = require('./audit');
const { agencySquareCall } = require('./agency-billing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

// Tables that have NO foreign-key cascade. Must be deleted explicitly.
// Each entry: { table, column } where column is what to filter by.
// All filter by subaccount_id except password_reset_tokens which uses subaccount_slug.
const NON_CASCADING_TABLES = [
  { table: 'appointments',              column: 'subaccount_id' },
  { table: 'appointment_reminders',     column: 'subaccount_id' },
  { table: 'email_log',                 column: 'subaccount_id' },
  { table: 'email_templates',           column: 'subaccount_id' },
  { table: 'failed_login_attempts',     column: 'subaccount_id' },
  { table: 'sessions',                  column: 'subaccount_id' },  // also revokes any active logins
  { table: 'sms_log',                   column: 'subaccount_id' },
  { table: 'sms_registration_requests', column: 'subaccount_id' },
  { table: 'sms_settings',              column: 'subaccount_id' },
  { table: 'subaccount_email_domains',  column: 'subaccount_id' }
];

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

// Main entry. opts.req for IP/UA, opts.actor with actorType/actorId/actorUsername/actorRole.
// opts.actionName: e.g. 'agency.subaccount.delete' or 'system.subaccount.auto_delete'.
// opts.reason: free-form string stored in metadata, e.g. 'manual' or 'cancelled_30_days'.
async function deleteSubaccount(subaccountId, opts) {
  opts = opts || {};
  const actor = opts.actor || {};
  const actionName = opts.actionName || 'agency.subaccount.delete';
  const reason = opts.reason || 'manual';
  const req = opts.req || { headers: {} };

  // ── Step 1: Load subaccount snapshot ──
  const subRes = await fetch(
    SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + encodeURIComponent(subaccountId) + '&select=*',
    { headers: sbHeaders() }
  );
  if (!subRes.ok) {
    return { success: false, error: 'Failed to load subaccount: ' + await subRes.text(), code: 'LOAD_FAILED' };
  }
  const subRows = await subRes.json();
  if (!subRows || !subRows.length) {
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
  const sub = subRows[0];

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

  // ── Load plan, email domain, sms settings for snapshot ──
  let plan = null;
  try {
    const planRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_plans?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=*',
      { headers: sbHeaders() }
    );
    if (planRes.ok) {
      const rows = await planRes.json();
      if (rows && rows.length) plan = rows[0];
    }
  } catch (e) { /* swallow */ }

  let emailDomain = null;
  try {
    const domainRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_email_domains?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=*',
      { headers: sbHeaders() }
    );
    if (domainRes.ok) {
      const rows = await domainRes.json();
      if (rows && rows.length) emailDomain = rows[0];
    }
  } catch (e) { /* swallow */ }

  let smsSettings = null;
  try {
    const smsRes = await fetch(
      SUPABASE_URL + '/rest/v1/sms_settings?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=*',
      { headers: sbHeaders() }
    );
    if (smsRes.ok) {
      const rows = await smsRes.json();
      if (rows && rows.length) smsSettings = rows[0];
    }
  } catch (e) { /* swallow */ }

  // Load subaccount_data so we can iterate customer cards (saved cards in contact records)
  let subaccountData = null;
  try {
    const dataRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=*',
      { headers: sbHeaders() }
    );
    if (dataRes.ok) {
      const rows = await dataRes.json();
      if (rows && rows.length) subaccountData = rows[0];
    }
  } catch (e) { /* swallow */ }

  // ── Step 3: Write audit log entry FIRST, before destruction ──
  const cleanupResults = {
    square_billing_card_disabled:   null,
    square_customer_cards_disabled: null,
    twilio_released:                null,
    resend_removed:                 null,
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
      resend_domain_id:    emailDomain && emailDomain.resend_domain_id,
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

  // ── Step 5: Disable customer Square cards (saved cards in contact records) ──
  // These are the patient/customer cards saved by the subaccount during POS workflows.
  // Disabling stops them from being chargeable, the Square customer record is preserved.
  try {
    let totalCards = 0;
    let disabledCards = 0;
    if (subaccountData && subaccountData.data) {
      let dbBlob = subaccountData.data;
      if (typeof dbBlob === 'string') {
        try { dbBlob = JSON.parse(dbBlob); } catch(e) { dbBlob = null; }
      }
      const contacts = (dbBlob && dbBlob.contacts) || [];
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
            // Card may already be disabled or invalid - log and continue
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

  // ── Step 6: Release Twilio number (best effort) ──
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

  // ── Step 7: Remove Resend domain (best effort) ──
  if (emailDomain && emailDomain.resend_domain_id) {
    try {
      const resendRes = await fetch(
        'https://api.resend.com/domains/' + emailDomain.resend_domain_id,
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY } }
      );
      cleanupResults.resend_removed = resendRes.ok;
      if (!resendRes.ok) {
        console.error('deleteSubaccount: Resend domain remove failed:', await resendRes.text());
      }
    } catch (e) {
      cleanupResults.resend_removed = false;
      console.error('deleteSubaccount: Resend remove threw:', e.message);
    }
  } else {
    cleanupResults.resend_removed = 'no_domain_to_remove';
  }

  // ── Step 8: Delete from non-cascading tables explicitly ──
  for (let i = 0; i < NON_CASCADING_TABLES.length; i++) {
    const t = NON_CASCADING_TABLES[i];
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/' + t.table + '?' + t.column + '=eq.' + encodeURIComponent(subaccountId),
        { method: 'DELETE', headers: sbHeaders({ 'Prefer': 'return=minimal' }) }
      );
      cleanupResults.rows_deleted[t.table] = r.ok ? 'ok' : ('failed_' + r.status);
      if (!r.ok) {
        console.error('deleteSubaccount: delete from ' + t.table + ' failed:', await r.text());
      }
    } catch (e) {
      cleanupResults.rows_deleted[t.table] = 'error';
      console.error('deleteSubaccount: delete from ' + t.table + ' threw:', e.message);
    }
  }

  // Special case: password_reset_tokens uses subaccount_slug, not subaccount_id
  if (sub.slug) {
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/password_reset_tokens?subaccount_slug=eq.' + encodeURIComponent(sub.slug),
        { method: 'DELETE', headers: sbHeaders({ 'Prefer': 'return=minimal' }) }
      );
      cleanupResults.rows_deleted.password_reset_tokens = r.ok ? 'ok' : ('failed_' + r.status);
    } catch (e) {
      cleanupResults.rows_deleted.password_reset_tokens = 'error';
    }
  }

  // ── Step 9: Final delete - subaccounts row (CASCADE handles the 8 FK'd tables) ──
  const finalDel = await fetch(
    SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + encodeURIComponent(subaccountId),
    { method: 'DELETE', headers: sbHeaders() }
  );

  if (!finalDel.ok) {
    const errText = await finalDel.text();
    await logAudit({
      req, ...actor,
      action: actionName,
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: 'Final delete failed: ' + errText,
      metadata: { reason: reason, cleanup_results: cleanupResults }
    });
    return { success: false, error: 'Final delete failed: ' + errText, code: 'DELETE_FAILED', cleanup_results: cleanupResults };
  }

  // ── Step 10: Write completion audit log ──
  // Determine partial vs full success based on cleanup results
  const externalFailures = (
    cleanupResults.square_billing_card_disabled === false ||
    cleanupResults.twilio_released === false ||
    cleanupResults.resend_removed === false ||
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
