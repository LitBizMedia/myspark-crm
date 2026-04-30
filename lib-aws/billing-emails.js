// lib/billing-emails.js
// Centralized billing email library for MySpark+.
// Each template function returns { subject, html }.
// To move to DB-driven templates later, replace getTemplate() with a Supabase fetch
// and keep sendEmail() unchanged. The caller interface stays the same.
//
// Usage:
//   const { sendEmail } = require('../lib/billing-emails');
//   await sendEmail(adminEmail, 'receipt', { subName, dollars, nextBillingDate, planTier, billingPeriod });
//
// Template types: receipt | payment_failed | past_due | suspended |
//                 trial_ending_soon | cancellation_confirmed |
//                 reactivation_confirmed | reactivation_no_charge

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = 'MySpark+ <noreply@mysparkplus.app>';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function sendEmail(to, type, data) {
  const template = getTemplate(type, data);
  if (!template) {
    console.error('billing-emails: unknown template type "' + type + '"');
    return { success: false, error: 'unknown template type' };
  }

  if (!RESEND_API_KEY) {
    console.log('billing-emails [' + type + '] to=' + to + ' (RESEND_API_KEY not set, skipped)');
    return { success: false, error: 'no RESEND_API_KEY' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject: template.subject,
        html: template.html
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('billing-emails: Resend error [' + type + ']:', errText);
      return { success: false, error: errText };
    }

    console.log('billing-emails: sent [' + type + '] to ' + to);
    return { success: true };

  } catch (e) {
    console.error('billing-emails: fetch error [' + type + ']:', e.message);
    return { success: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Template dispatcher
// Replace this function body with a Supabase fetch when moving to DB templates.
// ---------------------------------------------------------------------------

function getTemplate(type, data) {
  switch (type) {
    case 'receipt':                  return templateReceipt(data);
    case 'payment_failed':           return templatePaymentFailed(data);
    case 'past_due':                 return templatePastDue(data);
    case 'suspended':                return templateSuspended(data);
    case 'trial_ending_soon':        return templateTrialEndingSoon(data);
    case 'cancellation_confirmed':   return templateCancellationConfirmed(data);
    case 'reactivation_confirmed':   return templateReactivationConfirmed(data);
    case 'reactivation_no_charge':   return templateReactivationNoCharge(data);
    default:                         return null;
  }
}

// ---------------------------------------------------------------------------
// Shared HTML wrapper
// ---------------------------------------------------------------------------

function wrap(bodyHtml) {
  return (
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1030;background:#ffffff;">'
    + '<div style="border-bottom:3px solid #6b21ea;padding-bottom:16px;margin-bottom:24px;">'
    + '<span style="font-size:20px;font-weight:700;color:#6b21ea;letter-spacing:-0.5px;">MySpark+</span>'
    + '<span style="font-size:13px;color:#9b8ec4;margin-left:8px;">by LitBiz Media</span>'
    + '</div>'
    + bodyHtml
    + '<div style="border-top:1px solid rgba(107,33,234,.12);margin-top:32px;padding-top:16px;">'
    + '<p style="font-size:12px;color:#9b8ec4;margin:0;">Questions? Reply to this email or contact your MySpark+ administrator.</p>'
    + '</div>'
    + '</div>'
  );
}

function pill(text, color) {
  color = color || '#6b21ea';
  return (
    '<span style="display:inline-block;background:' + color + ';color:#fff;'
    + 'font-size:12px;font-weight:700;padding:3px 10px;border-radius:100px;'
    + 'letter-spacing:0.3px;">' + text + '</span>'
  );
}

function h2(text) {
  return '<h2 style="color:#1a1030;margin:0 0 12px;font-size:18px;">' + text + '</h2>';
}

function muted(text) {
  return '<p style="margin:0 0 14px;color:#5a4d7a;font-size:14px;line-height:1.6;">' + text + '</p>';
}

function bold(text) {
  return '<strong style="color:#1a1030;">' + text + '</strong>';
}

// ---------------------------------------------------------------------------
// Template: receipt
// data: { subName, dollars, nextBillingDate, planTier, billingPeriod }
// ---------------------------------------------------------------------------

function templateReceipt(data) {
  const subject = 'Payment confirmed - MySpark+ ' + (data.planTier || '') + ' plan';
  const html = wrap(
    h2('Payment confirmed')
    + pill('Paid', '#16a34a')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">'
    + (data.planTier || '') + (data.billingPeriod ? ' / ' + data.billingPeriod : '') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Amount charged</p>'
    + '<p style="margin:0 0 14px;font-size:22px;font-weight:700;color:#6b21ea;">$' + (data.dollars || '0.00') + '</p>'
    + (data.nextBillingDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Next billing date</p>'
        + '<p style="margin:0;font-size:15px;color:#1a1030;">' + data.nextBillingDate + '</p>'
      : '')
    + '</div>'
    + muted('Your MySpark+ subscription is active. Keep this email as your receipt.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: payment_failed
// data: { subName, dollars, retryCount, maxRetries, nextRetryDate }
// ---------------------------------------------------------------------------

function templatePaymentFailed(data) {
  const attemptsLeft = Math.max(0, (data.maxRetries || 3) - (data.retryCount || 0));
  const subject = 'Action required: MySpark+ payment failed';
  const html = wrap(
    h2('Payment failed')
    + pill('Action required', '#dc2626')
    + '<div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Amount due</p>'
    + '<p style="margin:0 0 14px;font-size:22px;font-weight:700;color:#dc2626;">$' + (data.dollars || '0.00') + '</p>'
    + (data.nextRetryDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Next retry</p>'
        + '<p style="margin:0;font-size:15px;color:#1a1030;">' + data.nextRetryDate + '</p>'
      : '')
    + '</div>'
    + muted('We were unable to charge your card on file. '
      + (attemptsLeft > 0
        ? 'We will retry automatically. ' + bold(attemptsLeft + ' attempt' + (attemptsLeft !== 1 ? 's' : '') + ' remaining') + ' before your account is suspended.'
        : 'Please update your payment method to avoid suspension.'))
    + muted('To update your card, contact your MySpark+ administrator.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: past_due
// data: { subName, dollars, retryCount }
// ---------------------------------------------------------------------------

function templatePastDue(data) {
  const subject = 'Urgent: MySpark+ account is past due';
  const html = wrap(
    h2('Account past due')
    + pill('Past due', '#b45309')
    + '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Balance due</p>'
    + '<p style="margin:0;font-size:22px;font-weight:700;color:#b45309;">$' + (data.dollars || '0.00') + '</p>'
    + '</div>'
    + muted('We have attempted to collect payment ' + bold((data.retryCount || 0) + ' time' + ((data.retryCount || 0) !== 1 ? 's' : '')) + ' without success.')
    + muted('Your account remains accessible for now, but suspension is approaching. Contact your MySpark+ administrator to update the card on file.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: suspended
// data: { subName, dollars }
// ---------------------------------------------------------------------------

function templateSuspended(data) {
  const subject = 'Your MySpark+ account has been suspended';
  const html = wrap(
    h2('Account suspended')
    + pill('Suspended', '#7f1d1d')
    + '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Outstanding amount</p>'
    + '<p style="margin:0;font-size:22px;font-weight:700;color:#7f1d1d;">$' + (data.dollars || '0.00') + '</p>'
    + '</div>'
    + muted('Access to your MySpark+ account has been disabled due to repeated failed payments.')
    + muted('To restore access, contact your MySpark+ administrator. Reactivation charges the outstanding balance immediately and restores your account to active status.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: trial_ending_soon
// data: { subName, trialEndDate, dollars }
// ---------------------------------------------------------------------------

function templateTrialEndingSoon(data) {
  const subject = 'Your MySpark+ free trial ends in 3 days';
  const html = wrap(
    h2('Your free trial ends soon')
    + pill('Trial ending', '#6b21ea')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Trial ends</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + (data.trialEndDate || 'soon') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Amount to be charged</p>'
    + '<p style="margin:0;font-size:22px;font-weight:700;color:#6b21ea;">$' + (data.dollars || '0.00') + '</p>'
    + '</div>'
    + muted('Your card on file will be charged automatically when the trial ends. No action needed if you want to continue.')
    + muted('To cancel before the trial ends, contact your MySpark+ administrator.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: cancellation_confirmed
// data: { subName, accessUntil }
// ---------------------------------------------------------------------------

function templateCancellationConfirmed(data) {
  const subject = 'MySpark+ subscription cancelled';
  const html = wrap(
    h2('Subscription cancelled')
    + pill('Cancelled', '#5a4d7a')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + (data.accessUntil
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Access continues until</p>'
        + '<p style="margin:0;font-size:15px;font-weight:700;color:#1a1030;">' + data.accessUntil + '</p>'
      : '')
    + '</div>'
    + muted('Your MySpark+ subscription has been cancelled. You will not be billed again.')
    + muted('Access remains fully available through the end of your current billing period. After that, your account and data will be retained for 30 days before automatic deletion.')
    + muted('Changed your mind? Contact your MySpark+ administrator to reactivate before access ends.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: reactivation_confirmed
// data: { subName, dollars, nextBillingDate, planTier }
// Sent when reactivation triggered a charge (suspended, past_due, or expired cancellation).
// ---------------------------------------------------------------------------

function templateReactivationConfirmed(data) {
  const subject = 'MySpark+ account reactivated';
  const html = wrap(
    h2('Account reactivated')
    + pill('Active', '#16a34a')
    + '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + (data.planTier
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan</p>'
        + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + data.planTier + '</p>'
      : '')
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Amount charged</p>'
    + '<p style="margin:0 0 14px;font-size:22px;font-weight:700;color:#16a34a;">$' + (data.dollars || '0.00') + '</p>'
    + (data.nextBillingDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Next billing date</p>'
        + '<p style="margin:0;font-size:15px;color:#1a1030;">' + data.nextBillingDate + '</p>'
      : '')
    + '</div>'
    + muted('Your MySpark+ account is fully restored. All data and settings are intact.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template: reactivation_no_charge
// data: { subName, nextBillingDate, planTier }
// Sent when reactivation happens within an already-paid billing period.
// No charge made because the customer already paid for the current cycle.
// ---------------------------------------------------------------------------

function templateReactivationNoCharge(data) {
  const subject = 'MySpark+ account reactivated, no charge today';
  const html = wrap(
    h2('Account reactivated')
    + pill('Active', '#16a34a')
    + '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + (data.planTier
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan</p>'
        + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + data.planTier + '</p>'
      : '')
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Status</p>'
    + '<p style="margin:0 0 14px;font-size:15px;font-weight:700;color:#16a34a;">No charge today</p>'
    + (data.nextBillingDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Next billing date</p>'
        + '<p style="margin:0;font-size:15px;color:#1a1030;">' + data.nextBillingDate + '</p>'
      : '')
    + '</div>'
    + muted('Your MySpark+ account is active again. You are still within your previously paid billing period, so no charge was made today.')
    + muted('Your card on file will be charged on your next billing date as scheduled.')
  );
  return { subject, html };
}

// ---------------------------------------------------------------------------

module.exports = { sendEmail, getTemplate };
