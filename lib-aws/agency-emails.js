// lib/agency-emails.js
// Agency-scope email library for MySpark+.
// Routes through lib/mailgun.js with scope='agency', from notifications@mg.mysparkplus.app.
//
// Templates:
//   Lifecycle: welcome_subaccount | plan_changed_upgrade | plan_change_scheduled
//   Security:  password_reset_by_admin | password_changed_self
//   SMS:       sms_request_received | sms_campaign_live
//   Skeleton:  card_expiring_soon | annual_renewal_reminder

const { sendEmail: mailgunSend } = require('./mailgun');

async function sendEmail(to, type, data) {
  const template = getTemplate(type, data);
  if (!template) {
    console.error('agency-emails: unknown template type "' + type + '"');
    return { success: false, error: 'unknown template type' };
  }
  const result = await mailgunSend(null, {
    scope: 'agency',
    to,
    subject: template.subject,
    html: template.html,
    fromName: 'MySpark+',
    templateType: type,
    subaccountId: data && data.subaccountId ? data.subaccountId : null
  });
  if (!result.ok) {
    console.error('agency-emails: send failed [' + type + ']:', result.error);
    return { success: false, error: result.error };
  }
  console.log('agency-emails: sent [' + type + '] to ' + to);
  return { success: true, id: result.id };
}

function getTemplate(type, data) {
  switch (type) {
    case 'welcome_subaccount':       return templateWelcomeSubaccount(data);
    case 'password_reset_by_admin':  return templatePasswordResetByAdmin(data);
    case 'password_changed_self':    return templatePasswordChangedSelf(data);
    case 'sms_request_received':     return templateSmsRequestReceived(data);
    case 'sms_campaign_live':        return templateSmsCampaignLive(data);
    case 'plan_changed_upgrade':     return templatePlanChangedUpgrade(data);
    case 'plan_change_scheduled':    return templatePlanChangeScheduled(data);
    case 'card_expiring_soon':       return templateCardExpiringSoon(data);
    case 'annual_renewal_reminder':  return templateAnnualRenewalReminder(data);
    default:                         return null;
  }
}

const USD = String.fromCharCode(36);

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
  return '<span style="display:inline-block;background:' + color + ';color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:100px;letter-spacing:0.3px;">' + text + '</span>';
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

function templateWelcomeSubaccount(data) {
  const subject = 'Welcome to MySpark+ - your account is ready';
  const trialLine = data.trialDays > 0
    ? 'Your ' + data.trialDays + '-day free trial starts today.'
    : 'Your subscription is active.';
  const html = wrap(
    h2('Welcome to MySpark+')
    + pill('Account ready', '#16a34a')
    + muted('Hi ' + (data.adminName || 'there') + ',')
    + muted('Your MySpark+ workspace has been created and is ready to use. ' + trialLine)
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Workspace</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your workspace') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + (data.planTier || '') + (data.billingPeriod ? ' / ' + data.billingPeriod : '') + '</p>'
    + '</div>'
    + (data.setupUrl
      ? '<div style="text-align:center;margin:24px 0;"><a href="' + data.setupUrl + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:8px;font-size:15px;">Set up your password</a></div>'
        + muted('Click the button above to create your password and access your workspace. This link expires in 7 days.')
      : (data.loginUrl
          ? '<div style="text-align:center;margin:24px 0;"><a href="' + data.loginUrl + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px;font-size:15px;">Sign in to MySpark+</a></div>'
          : ''))
    + muted('Need help getting started? Reply to this email and our team will assist.')
  );
  return { subject, html };
}

function templatePasswordResetByAdmin(data) {
  const subject = 'Your MySpark+ password was reset';
  const html = wrap(
    h2('Password reset')
    + pill('Security notice', '#b45309')
    + muted('Hi ' + (data.userName || 'there') + ',')
    + muted('Your password for ' + bold(data.subName || 'your MySpark+ workspace') + ' was reset by ' + bold(data.resetByName || 'an administrator') + '.')
    + (data.resetUrl
      ? '<div style="text-align:center;margin:24px 0;"><a href="' + data.resetUrl + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:8px;font-size:15px;">Reset your password</a></div>'
        + muted('Click the button above to choose a new password. This link expires in 60 minutes for security.')
      : (data.loginUrl
          ? '<div style="text-align:center;margin:24px 0;"><a href="' + data.loginUrl + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px;font-size:15px;">Sign in to MySpark+</a></div>'
          : ''))
    + muted(bold('If you did not request this change, ') + 'contact your MySpark+ administrator immediately and do not click the link above.')
  );
  return { subject, html };
}

function templatePasswordChangedSelf(data) {
  const subject = 'MySpark+ password changed';
  const html = wrap(
    h2('Your password was changed')
    + pill('Security notice', '#5a4d7a')
    + muted('Hi ' + (data.userName || 'there') + ',')
    + muted('This is a confirmation that the password for your MySpark+ account was successfully changed.')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Workspace</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + (data.changedAt ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Changed at</p><p style="margin:0;font-size:15px;color:#1a1030;">' + data.changedAt + '</p>' : '')
    + '</div>'
    + muted(bold('If you did not make this change, ') + 'contact your MySpark+ administrator immediately to secure your account.')
  );
  return { subject, html };
}

function templateSmsRequestReceived(data) {
  const subject = 'SMS registration submitted - MySpark+';
  const html = wrap(
    h2('SMS registration received')
    + pill('In review', '#6b21ea')
    + muted('Hi ' + (data.contactName || 'there') + ',')
    + muted('We have received your SMS registration request for ' + bold(data.businessName || data.subName || 'your business') + '.')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">What happens next</p>'
    + '<ol style="margin:8px 0 0;padding-left:20px;color:#1a1030;font-size:14px;line-height:1.8;">'
    + '<li>Our team reviews your business details and use case</li>'
    + '<li>We provision a Twilio number and submit your campaign for 10DLC approval</li>'
    + '<li>Carrier approval typically takes 1 to 3 weeks</li>'
    + '<li>You receive a confirmation email when SMS is live</li>'
    + '</ol></div>'
    + muted('Carrier 10DLC requirements are designed to reduce spam. We will follow up if any additional information is needed.')
    + muted('Questions? Reply to this email.')
  );
  return { subject, html };
}

function templateSmsCampaignLive(data) {
  const subject = 'Your MySpark+ SMS is now live';
  const html = wrap(
    h2('SMS is live')
    + pill('Active', '#16a34a')
    + muted('Great news. Your SMS campaign for ' + bold(data.businessName || data.subName || 'your business') + ' has been approved by carriers and is now live.')
    + '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Your SMS number</p>'
    + '<p style="margin:0 0 14px;font-size:22px;font-weight:700;font-family:monospace;color:#16a34a;">' + (data.twilioNumber || 'Number provisioned') + '</p>'
    + '<p style="margin:0;font-size:13px;color:#5a4d7a;">Status: ' + bold('Approved and active') + '</p></div>'
    + muted('You can now send appointment reminders, automation messages, and patient communications via SMS from inside MySpark+.')
    + muted('SMS usage is tracked against your monthly plan limit. Check your billing dashboard for current usage.')
  );
  return { subject, html };
}

function templatePlanChangedUpgrade(data) {
  const subject = 'MySpark+ plan upgraded - ' + (data.newPlan || 'new plan');
  const html = wrap(
    h2('Plan upgraded')
    + pill('Upgraded', '#16a34a')
    + '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan change</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + (data.oldPlan || 'Previous') + ' &rarr; ' + bold(data.newPlan || 'New plan') + '</p>'
    + (data.prorationAmount
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Prorated charge today</p><p style="margin:0 0 14px;font-size:22px;font-weight:700;color:#16a34a;">' + USD + data.prorationAmount + '</p>'
      : '')
    + (data.nextBillingDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Next billing date</p><p style="margin:0;font-size:15px;color:#1a1030;">' + data.nextBillingDate + (data.billingPeriod ? ' (' + data.billingPeriod + ')' : '') + '</p>'
      : '')
    + '</div>'
    + muted('The new plan features are immediately available. The prorated amount above covers the upgrade from today until your next billing date.')
  );
  return { subject, html };
}

function templatePlanChangeScheduled(data) {
  const subject = 'MySpark+ plan change scheduled';
  const html = wrap(
    h2('Plan change scheduled')
    + pill('Scheduled', '#6b21ea')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan change</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + (data.oldPlan || 'Current') + ' &rarr; ' + bold(data.newPlan || 'New plan') + '</p>'
    + (data.effectiveDate
      ? '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Effective date</p><p style="margin:0;font-size:15px;font-weight:700;color:#6b21ea;">' + data.effectiveDate + '</p>'
      : '')
    + '</div>'
    + muted('You keep your current plan features until the effective date. After that date, the new plan and pricing take effect.')
    + muted('Changed your mind? Contact your MySpark+ administrator to cancel the scheduled change before it applies.')
  );
  return { subject, html };
}

function templateCardExpiringSoon(data) {
  const subject = 'Action recommended: card expires soon - MySpark+';
  const html = wrap(
    h2('Your card expires soon')
    + pill('Update recommended', '#b45309')
    + '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Card on file</p>'
    + '<p style="margin:0 0 14px;font-size:15px;font-family:monospace;color:#1a1030;">&bull;&bull;&bull;&bull; ' + (data.cardLast4 || '****') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Expires</p>'
    + '<p style="margin:0;font-size:22px;font-weight:700;color:#b45309;">' + (data.expMonth || '00') + '/' + (data.expYear || '0000') + '</p>'
    + '</div>'
    + muted('To prevent payment failure on your next charge, please update your card. Your card expires in ' + bold((data.daysUntilExpiry || 0) + ' day' + ((data.daysUntilExpiry || 0) !== 1 ? 's' : '')) + '.')
    + muted('Contact your MySpark+ administrator to update your card.')
  );
  return { subject, html };
}

function templateAnnualRenewalReminder(data) {
  const subject = 'Your annual MySpark+ subscription renews soon';
  const html = wrap(
    h2('Annual renewal coming up')
    + pill('Heads up', '#6b21ea')
    + '<div style="background:#f2f0f8;border-radius:8px;padding:16px 20px;margin:16px 0;">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Account</p>'
    + '<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1030;">' + (data.subName || 'Your account') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Plan</p>'
    + '<p style="margin:0 0 14px;font-size:15px;color:#1a1030;">' + (data.planTier || 'Annual plan') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Renewal amount</p>'
    + '<p style="margin:0 0 14px;font-size:22px;font-weight:700;color:#6b21ea;">' + USD + (data.dollars || '0.00') + '</p>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5a4d7a;">Renews on</p>'
    + '<p style="margin:0;font-size:15px;font-weight:700;color:#1a1030;">' + (data.renewalDate || 'soon') + '</p>'
    + '</div>'
    + muted('Your annual subscription renews automatically. Your card on file will be charged on the renewal date.')
    + muted('Need to make changes? Contact your MySpark+ administrator at least 24 hours before the renewal date.')
  );
  return { subject, html };
}

module.exports = { sendEmail, getTemplate };
