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

const PUBLIC_FORM_BASE = 'https://mysparkplus.app';
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
  return PUBLIC_FORM_BASE + '/' + slug + '?fbembed=' + encodeURIComponent(formId) + '&t=' + encodeURIComponent(token);
}

// Load the subaccount's display business name from settings, matching every
// other subaccount email (see booking-submit: settings.businessName || slug).
// subaccounts.name (what mailgun's getSubaccountName returns) is NOT the same
// as the clinic-set settings.businessName, so we resolve it explicitly here.
async function resolveBusinessName(subaccountId, slug) {
  try {
    const r = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
      [subaccountId]
    );
    const settings = (r.rows[0] && r.rows[0].data && r.rows[0].data.settings) || {};
    return settings.businessName || slug || 'Our Practice';
  } catch (e) {
    console.error('intake-dispatch: business name load failed:', e.message);
    return slug || 'Our Practice';
  }
}

// Minimal HTML escaper for interpolated values.
function escIntake(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build a branded intake email: business header, greeting, optional custom
// message, a clear button (token hidden behind it), and a small fallback link.
function buildIntakeEmailHtml(opts) {
  const biz = escIntake(opts.businessName);
  const name = opts.contactName ? escIntake(opts.contactName.split(' ')[0]) : '';
  const greeting = name ? ('Hi ' + name + ',') : 'Hello,';
  const formName = escIntake(opts.formName || 'form');
  const link = opts.link;
  // Custom message (plain text from the form settings) -> paragraphs, line
  // breaks preserved, HTML-escaped so it can't inject markup.
  let messageBlock;
  if (opts.customMessage && opts.customMessage.trim()) {
    const safe = escIntake(opts.customMessage.trim()).replace(/\n/g, '<br>');
    messageBlock = '<p style="color:#1a1030;font-size:15px;line-height:1.6;margin:0 0 20px">' + safe + '</p>';
  } else {
    messageBlock = '<p style="color:#1a1030;font-size:15px;line-height:1.6;margin:0 0 20px">'
      + 'Please take a moment to complete the ' + formName + ' below. It only takes a few minutes.</p>';
  }
  return '<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#ffffff;border:1px solid #ece9f3;border-radius:14px;overflow:hidden">'
    + '<div style="background:#6b21ea;padding:22px 28px"><div style="color:#ffffff;font-size:18px;font-weight:700">' + biz + '</div></div>'
    + '<div style="padding:28px">'
    + '<p style="color:#1a1030;font-size:16px;font-weight:600;margin:0 0 14px">' + greeting + '</p>'
    + messageBlock
    + '<div style="text-align:center;margin:28px 0">'
    + '<a href="' + link + '" style="display:inline-block;background:#6b21ea;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 34px;border-radius:10px">Complete Your Form</a>'
    + '</div>'
    + '<p style="color:#5a4d7a;font-size:12px;line-height:1.5;margin:24px 0 0;border-top:1px solid #ece9f3;padding-top:16px">'
    + 'If the button does not work, copy and paste this link into your browser:<br>'
    + '<a href="' + link + '" style="color:#6b21ea;word-break:break-all">' + link + '</a></p>'
    + '</div>'
    + '<div style="background:#faf9fc;padding:16px 28px;text-align:center"><div style="color:#9b92b3;font-size:12px">' + biz + '</div></div>'
    + '</div>';
}

// Decide whether to skip this automatic send based on the form's frequency
// policy. intake_sends is a send LOG (multiple rows per contact+form allowed).
//   'once'     => skip if ANY prior send exists (first-time-only intake)
//   'always'   => never skip; send on every qualifying booking
//   'periodic' => skip only if a send exists within the last periodicDays
// force=true (manual staff send) bypasses this entirely, checked by the caller.
async function shouldSkipByPolicy(subaccountId, contactId, formId, config) {
  const freq = (config && config.sendFrequency) || 'once';
  if (freq === 'always') return { skip: false };
  if (freq === 'periodic') {
    var days = parseInt(config && config.periodicDays, 10);
    if (!days || days < 1) days = 90; // safe default
    var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    var recent = await db.query(
      `SELECT id FROM intake_sends
       WHERE subaccount_id=$1 AND contact_id=$2 AND form_id=$3 AND sent_at IS NOT NULL AND sent_at > $4
       ORDER BY sent_at DESC LIMIT 1`,
      [subaccountId, contactId, formId, cutoff]);
    if (recent.rows.length) return { skip: true, reason: 'within_periodic_window', intake_id: recent.rows[0].id };
    return { skip: false };
  }
  // default 'once': skip if any send exists at all
  var any = await db.query(
    `SELECT id FROM intake_sends
     WHERE subaccount_id=$1 AND contact_id=$2 AND form_id=$3 LIMIT 1`,
    [subaccountId, contactId, formId]);
  if (any.rows.length) return { skip: true, reason: 'already_on_file', intake_id: any.rows[0].id };
  return { skip: false };
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

  // 1. Frequency-policy guard. force=true (manual staff send) bypasses it.
  if (!force) {
    const decision = await shouldSkipByPolicy(subaccountId, contactId, formId, config);
    if (decision.skip) {
      return { ok: true, skipped: true, reason: decision.reason, intake_id: decision.intake_id };
    }
  }

  // 2. Build the signed attribution link.
  const link = await buildFormLink(slug, subaccountId, formId, contactId, config.linkTtlDays);
  const businessName = await resolveBusinessName(subaccountId, slug);

  // 3. Send on each enabled+allowed channel. Record what actually went out.
  const channels = { email: false, sms: false };
  const errors = [];

  if (config.sendEmail && config.contactEmail) {
    try {
      const r = await sendEmail(slug, {
        scope: 'subaccount',
        source: 'intake-form',
        to: config.contactEmail,
        subject: config.emailSubject || ((config.formName || 'Your form') + ' from ' + businessName),
        html: buildIntakeEmailHtml({
          businessName,
          contactName: config.contactName,
          formName: config.formName,
          customMessage: config.emailMessage || config.emailBody || '',
          link
        }),
        fromName: businessName,
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

  // 4. Append-only: every actual send is a new row in the log. No refresh path.
  //    A force-resend also inserts a fresh row, so the log shows each send event.
  try {
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
  } catch (e) {
    return { ok: false, error: 'intake_sends write failed: ' + e.message, channels, send_errors: errors };
  }
}

module.exports = { dispatchIntake };
