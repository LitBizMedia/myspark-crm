// lib-aws/intake-dispatch.js
//
// One brain for sending an intake form to a contact. Called by:
//   - booking-submit (automatic, first qualifying service booking)
//   - a manual "resend" endpoint (force = true, staff-initiated)
//   - later: contact-created trigger (automatic)
//
// Responsibilities:
//   1. On-file guard: automatic sends fire once per (subaccount, contact, form).
//      force=true bypasses the guard for deliberate staff resends.
//   2. Build the signed form link (TOKEN SIGNING STUBBED — see step 3).
//   3. Send via Mailgun (if config.sendEmail) and Twilio (if config.sendSms
//      AND the subaccount SMS campaign gate allows).
//   4. Write/refresh the intake_sends row with status + channels.
//
// Does NOT handle the reminder nudge. Unfilled-row nudges are the reminder
// cron's job, reading intake_sends where status='sent'. Out of scope here.
//
// PHI note: the token carries contact_id so the eventual submission attributes
// to the right contact. The signing wiring is the next step, intentionally
// deferred. Until it lands, links are unsigned and attribution falls back to
// form-submit's existing email/phone cascade.

const db = require('./db');
const { sendEmail } = require('./mailgun');
const { sendSms } = require('./twilio');
const { canSubaccountSendSms } = require('./sms-gate');
const tokens = require('./tokens');

const PUBLIC_FORM_BASE = 'https://book.mysparkplus.app';
// Default intake link lifetime. Config-overridable per send (config.linkTtlDays).
const DEFAULT_LINK_TTL_DAYS = 30;

function newIntakeId() {
  return 'intk_' + Math.random().toString(36).slice(2, 14);
}

// Build the public form URL with a signed attribution token.
// The token carries { subaccountId, contactId, formId, exp }. It authorizes
// ATTRIBUTION ONLY: form-submit reads contactId from it so the submission
// attaches to the right contact. It returns no PHI. A leaked link cannot
// expose contact data; worst case is a misattributed submission, the same
// risk the email-match cascade already carries.
async function buildFormLink(slug, subaccountId, formId, contactId, ttlDays) {
  const days = (typeof ttlDays === 'number' && ttlDays > 0) ? ttlDays : DEFAULT_LINK_TTL_DAYS;
  const exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const token = await tokens.signToken({ subaccountId, contactId, formId, exp });
  return PUBLIC_FORM_BASE + '/' + slug + '/' + formId + '?t=' + encodeURIComponent(token);
}

// Look up an existing intake_sends row for this contact+form.
async function findExistingSend(subaccountId, contactId, formId) {
  return db.findOne('intake_sends', {
    subaccount_id: subaccountId,
    contact_id: contactId,
    form_id: formId
  });
}

// Main entry point.
// opts: { subaccountId, contactId, formId, triggerEvent, appointmentId, slug, config, force }
// config: { sendEmail, sendSms, emailSubject, emailHtml, smsBody, formName, contactEmail, contactPhone, contactName }
// Returns: { ok, skipped?, reason?, intake_id?, channels? }
async function dispatchIntake(opts) {
  const {
    subaccountId, contactId, formId,
    triggerEvent, appointmentId, slug,
    config, force
  } = opts || {};

  if (!subaccountId || !contactId || !formId) {
    return { ok: false, error: 'subaccountId, contactId, formId required' };
  }
  if (!config) {
    return { ok: false, error: 'intake config required' };
  }

  // 1. On-file guard. Automatic sends fire once per contact+form.
  //    force=true (manual staff resend) bypasses and refreshes the row.
  const existing = await findExistingSend(subaccountId, contactId, formId);
  if (existing && !force) {
    return { ok: true, skipped: true, reason: 'already_on_file', intake_id: existing.id };
  }

  // 2. Build the signed attribution link.
  const link = await buildFormLink(slug, subaccountId, formId, contactId, config.linkTtlDays);

  // 3. Send on each enabled+allowed channel. Record what actually went out.
  const channels = { email: false, sms: false };
  const errors = [];

  if (config.sendEmail && config.contactEmail) {
    try {
      const r = await sendEmail(slug, {
        scope: 'subaccount',
        source: 'intake-form',
        to: config.contactEmail,
        subject: config.emailSubject || ('Please complete your form: ' + (config.formName || 'Intake')),
        html: (config.emailHtml || '<p>Please complete your form.</p>')
              + '<p><a href="' + link + '">' + link + '</a></p>',
        fromName: config.fromName || 'MySpark+',
        contactId: contactId
      });
      channels.email = !!(r && r.ok);
      if (!channels.email) errors.push('email: ' + (r && r.error));
    } catch (e) {
      errors.push('email threw: ' + e.message);
    }
  }

  if (config.sendSms && config.contactPhone) {
    let smsAllowed = false;
    try {
      smsAllowed = await canSubaccountSendSms(subaccountId, db);
    } catch (e) {
      errors.push('sms gate threw: ' + e.message);
    }
    if (smsAllowed) {
      try {
        const r = await sendSms(slug, {
          to: config.contactPhone,
          body: (config.smsBody || 'Please complete your form: ') + ' ' + link,
          contactId: contactId,
          purpose: 'transactional'
        });
        channels.sms = !!(r && r.ok);
        if (!channels.sms) errors.push('sms: ' + (r && r.error));
      } catch (e) {
        errors.push('sms threw: ' + e.message);
      }
    } else {
      errors.push('sms: campaign gate not live');
    }
  }

  const anySent = channels.email || channels.sms;
  const status = anySent ? 'sent' : 'send_failed';
  const nowIso = new Date().toISOString();

  // 4. Write or refresh the intake_sends row.
  try {
    if (existing) {
      // force resend: refresh the existing row, never duplicate.
      await db.update('intake_sends',
        {
          trigger_event: triggerEvent || existing.trigger_event,
          appointment_id: appointmentId || existing.appointment_id,
          status: status,
          channels: JSON.stringify(channels),
          sent_at: anySent ? nowIso : existing.sent_at,
          updated_at: nowIso
        },
        { id: existing.id }
      );
      return { ok: true, intake_id: existing.id, channels, status, resent: true, errors };
    } else {
      const id = newIntakeId();
      await db.insertOne('intake_sends', {
        id,
        subaccount_id: subaccountId,
        contact_id: contactId,
        form_id: formId,
        trigger_event: triggerEvent || 'unknown',
        appointment_id: appointmentId || null,
        status,
        channels: JSON.stringify(channels),
        sent_at: anySent ? nowIso : null
      });
      return { ok: true, intake_id: id, channels, status, errors };
    }
  } catch (e) {
    return { ok: false, error: 'intake_sends write failed: ' + e.message, channels, send_errors: errors };
  }
}

module.exports = { dispatchIntake };
