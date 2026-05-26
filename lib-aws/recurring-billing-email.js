// lib-aws/recurring-billing-email.js
//
// Patient-facing recurring billing notification sender. Handles 8 events:
//   - trial_ending          (live since Phase 1, fires from subscriptions-charge cron)
//   - enrollment            (fires from subscriptions-create)
//   - upcoming_charge       (fires from subscriptions-charge cron, NEW scan)
//   - payment_failed        (fires from sub-charge handleChargeFailure)
//   - suspended             (fires from sub-charge when retries exhausted)
//   - paused                (fires from subscriptions-update pause action)
//   - resumed               (fires from subscriptions-update resume action)
//   - cancelled             (fires from subscriptions-update cancel action)
//
// Each event maps to a catalog key like recurring_billing_<event>. Gate checks
// via shouldSend. Email failures are non-fatal to the calling Lambda.

const { sendEmail } = require('./mailgun');
const db = require('./db');
const { shouldSend } = require('./notifications');

// Load contact + business name + timezone for a subscription event send.
// Returns null if the contact has no email (skip silently). Otherwise returns
// the bundle of fields the sender needs. One DB hit for contact, one for blob.
async function _loadContext(subaccountId, contactId) {
  const contactsLib = require('./contacts');
  const contact = await contactsLib.getContactById(subaccountId, contactId);
  if (!contact || !contact.email) return null;

  let businessName = 'MySpark+';
  let timezone = 'America/Indiana/Indianapolis';
  try {
    const sdRow = await db.findOne('subaccount_data', { subaccount_id: subaccountId });
    const settings = (sdRow && sdRow.data && sdRow.data.settings) || {};
    businessName = settings.businessName || settings.business_name || businessName;
    timezone = settings.timezone || timezone;
  } catch (e) { /* fall back to defaults */ }

  const slug = String(subaccountId || '').replace(/^sub-/, '');
  return {
    subaccountId,
    subaccountSlug: slug,
    recipientEmail: contact.email,
    recipientName: contact.name || contact.first_name || '',
    contactId: contact.id,
    businessName,
    timezone
  };
}

const EVENT_TO_TYPE_KEY = {
  enrollment:       'recurring_billing_enrollment',
  upcoming_charge:  'recurring_billing_upcoming_charge',
  payment_failed:   'recurring_billing_payment_failed',
  suspended:        'recurring_billing_suspended',
  paused:           'recurring_billing_paused',
  resumed:          'recurring_billing_resumed',
  cancelled:        'recurring_billing_cancelled'
  // trial_ending handled by subscriptions-charge directly (already live)
};

function fmt$(n) {
  return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
}

function fmtDate(d, tz) {
  if (!d) return '';
  try {
    const s = (typeof d === 'string') ? d.slice(0, 10) : null;
    if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const [y, m, day] = s.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: tz || 'America/Indiana/Indianapolis'
      });
    }
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  } catch (e) { return String(d); }
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Event-specific content. Each returns { heading, intro, table, footer }.
function buildContent(eventType, opts) {
  const planName = opts.planName || 'your subscription';
  const amount = fmt$(opts.amount || 0);
  const nextDate = opts.nextDate ? fmtDate(opts.nextDate, opts.timezone) : '';
  const reason = opts.reason || '';

  switch (eventType) {
    case 'enrollment':
      return {
        heading: 'Welcome to ' + escHtml(planName),
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', thanks for signing up. Your subscription is now active.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Amount', amount],
          ['Billing cycle', escHtml(opts.billingCycle || 'monthly')],
          nextDate ? ['Next charge', nextDate] : null
        ].filter(Boolean),
        footer: 'Your card on file will be charged automatically each cycle. Reply to this email if you have any questions.'
      };
    case 'upcoming_charge':
      return {
        heading: 'Upcoming charge reminder',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', this is a reminder that your ' + escHtml(planName) + ' will be charged soon.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Amount', amount],
          ['Charge date', nextDate]
        ],
        footer: 'Your card on file will be charged automatically. To make changes, contact us before the charge date.'
      };
    case 'payment_failed':
      return {
        heading: 'Payment did not go through',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ", we tried to charge your card for " + escHtml(planName) + ' but the payment did not go through.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Amount attempted', amount],
          reason ? ['Reason', escHtml(reason)] : null
        ].filter(Boolean),
        footer: 'Please update your card on file or contact us so we can resolve this. We will retry the charge automatically.'
      };
    case 'suspended':
      return {
        heading: 'Your subscription has been suspended',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', after multiple failed charges, your ' + escHtml(planName) + ' has been suspended.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Status', 'Suspended']
        ],
        footer: 'No further charges will be attempted until you update your card on file or resume the subscription. Contact us to resolve this.'
      };
    case 'paused':
      return {
        heading: 'Your subscription has been paused',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', your ' + escHtml(planName) + ' has been paused.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Status', 'Paused'],
          reason ? ['Reason', escHtml(reason)] : null
        ].filter(Boolean),
        footer: 'You will not be charged while paused. Contact us when you would like to resume.'
      };
    case 'resumed':
      return {
        heading: 'Welcome back',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', your ' + escHtml(planName) + ' is active again.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Status', 'Active'],
          nextDate ? ['Next charge', nextDate] : null
        ].filter(Boolean),
        footer: 'Your card on file will be charged on the next billing date.'
      };
    case 'cancelled':
      return {
        heading: 'Your subscription has been cancelled',
        intro: 'Hi ' + escHtml(opts.patientName || 'there') + ', your ' + escHtml(planName) + ' has been cancelled.',
        rows: [
          ['Plan', escHtml(planName)],
          ['Status', 'Cancelled'],
          reason ? ['Reason', escHtml(reason)] : null
        ].filter(Boolean),
        footer: 'No further charges will be made. Thank you for being a customer.'
      };
    default:
      return null;
  }
}

function buildHtml(eventType, opts) {
  const content = buildContent(eventType, opts);
  if (!content) return null;
  const businessName = opts.businessName || 'MySpark+';

  const rowsHtml = content.rows.map(function (row) {
    return '<tr>'
      + '<td style="padding:8px 0;color:#5a4d7a;font-size:14px;width:140px">' + row[0] + '</td>'
      + '<td style="padding:8px 0;font-weight:600">' + row[1] + '</td>'
      + '</tr>';
  }).join('');

  return ''
    + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1030">'
    + '<h2 style="color:#6b21ea;margin:0 0 8px">' + content.heading + '</h2>'
    + '<p style="margin:0 0 24px;color:#5a4d7a;font-size:15px">' + content.intro + '</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:0 0 24px">' + rowsHtml + '</table>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:0 0 4px">' + content.footer + '</p>'
    + '<p style="color:#5a4d7a;font-size:14px;margin:24px 0 0">Thanks,<br>' + escHtml(businessName) + '</p>'
    + '</div>';
}

/**
 * Send a recurring billing notification to a patient.
 *
 * @param {string} eventType - one of: enrollment, upcoming_charge, payment_failed,
 *                             suspended, paused, resumed, cancelled
 * @param {object} opts
 * @param {string} opts.subaccountId    - 'sub-xxx'
 * @param {string} opts.subaccountSlug  - slug without 'sub-' prefix
 * @param {string} opts.recipientEmail
 * @param {string} opts.recipientName
 * @param {string} opts.contactId
 * @param {string} opts.businessName
 * @param {string} opts.planName
 * @param {number} opts.amount
 * @param {string} [opts.billingCycle]
 * @param {string} [opts.nextDate]      - ISO date for next charge
 * @param {string} [opts.timezone]
 * @param {string} [opts.reason]
 */
async function sendRecurringBillingEmail(eventType, opts) {
  if (!opts || !opts.subaccountId) return { ok: false, error: 'no subaccountId' };
  const typeKey = EVENT_TO_TYPE_KEY[eventType];
  if (!typeKey) return { ok: false, error: 'unknown eventType: ' + eventType };
  if (!opts.recipientEmail) return { ok: true, skipped: true, reason: 'no recipient email' };

  // Gate via Notifications tab
  const gate = await shouldSend(opts.subaccountId, typeKey, db);
  if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason || 'disabled' };

  const html = buildHtml(eventType, opts);
  if (!html) return { ok: false, error: 'no html for event' };

  const subjects = {
    enrollment:      'Welcome to ' + (opts.planName || 'your subscription'),
    upcoming_charge: 'Upcoming charge: ' + fmt$(opts.amount || 0),
    payment_failed:  'Payment failed for your subscription',
    suspended:       'Your subscription has been suspended',
    paused:          'Your subscription has been paused',
    resumed:         'Your subscription is active again',
    cancelled:       'Your subscription has been cancelled'
  };
  const subject = subjects[eventType] || 'Subscription update';

  try {
    const result = await sendEmail(opts.subaccountSlug, {
      scope: 'subaccount',
      source: 'system',
      to: opts.recipientEmail,
      subject: subject,
      html: html,
      fromName: opts.businessName || 'MySpark+',
      templateType: typeKey,
      contactId: opts.contactId,
      vars: {
        contact_name: opts.recipientName || '',
        plan_name: opts.planName || '',
        amount: fmt$(opts.amount || 0),
        business_name: opts.businessName || 'MySpark+'
      }
    });
    return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendRecurringBillingEmail, EVENT_TO_TYPE_KEY, _loadContext };
