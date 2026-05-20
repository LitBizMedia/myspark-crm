// lib/automation-actions.js
// Action handlers for automation engine.
//
// Consent rules:
//   - is_transactional automations bypass marketing consent
//   - All automations respect hard suppression (email_suppressed)
//   - SMS always requires the matching consent flag (transactional or marketing)

const db = require('./db');
const contactsLib = require('./contacts');
const mailgun = require('./mailgun');
const twilio = require('./twilio');
const { substituteVars } = require('./automation-vars');

async function actionSendEmail(automation, contact, slug, vars) {
  const cfg = automation.action_config || {};
  const subject = substituteVars(cfg.subject || '', vars);
  const html = substituteVars(cfg.body_html || '', vars);

  if (!contact.email) return { status: 'skipped_no_contact_info' };
  if (contact.email_suppressed) return { status: 'skipped_suppressed' };
  if (!automation.is_transactional && !contact.email_marketing_consent) {
    return { status: 'skipped_consent_email' };
  }
  if (!subject || !html) return { status: 'failed', error: 'Empty subject or body' };

  const sendRes = await mailgun.sendEmail(slug, {
    to: contact.email,
    subject,
    html,
    scope: 'subaccount'
  });

  if (!sendRes.ok) return { status: 'failed', error: sendRes.error || 'Mailgun send failed' };
  return { status: 'success' };
}

async function actionSendSms(automation, contact, slug, vars) {
  const cfg = automation.action_config || {};
  const body = substituteVars(cfg.body || '', vars);

  if (!contact.phone) return { status: 'skipped_no_contact_info' };

  if (automation.is_transactional) {
    if (!contact.sms_consent_transactional) return { status: 'skipped_consent_sms' };
  } else {
    if (!contact.sms_consent_marketing) return { status: 'skipped_consent_sms' };
  }

  if (!body) return { status: 'failed', error: 'Empty SMS body' };

  const sendRes = await twilio.sendSms(slug, {
    to: contact.phone,
    body,
    contactId: contact.id
  });

  if (!sendRes.ok) return { status: 'failed', error: sendRes.error || 'Twilio send failed' };
  return { status: 'success' };
}

async function actionAddTag(automation, contact, subaccountId) {
  const cfg = automation.action_config || {};
  const tag = cfg.tag;
  if (!tag) return { status: 'failed', error: 'No tag specified' };

  const existingTags = Array.isArray(contact.tags) ? contact.tags : [];
  if (existingTags.includes(tag)) return { status: 'success' };

  const newTags = existingTags.concat([tag]);
  await db.query(
    'UPDATE contacts SET tags = $1::jsonb, updated_at = NOW() WHERE id = $2 AND subaccount_id = $3',
    [JSON.stringify(newTags), contact.id, subaccountId]
  );
  return { status: 'success' };
}

async function actionRemoveTag(automation, contact, subaccountId) {
  const cfg = automation.action_config || {};
  const tag = cfg.tag;
  if (!tag) return { status: 'failed', error: 'No tag specified' };

  const existingTags = Array.isArray(contact.tags) ? contact.tags : [];
  if (!existingTags.includes(tag)) return { status: 'success' };

  const newTags = existingTags.filter(function(t) { return t !== tag; });
  await db.query(
    'UPDATE contacts SET tags = $1::jsonb, updated_at = NOW() WHERE id = $2 AND subaccount_id = $3',
    [JSON.stringify(newTags), contact.id, subaccountId]
  );
  return { status: 'success' };
}

async function runAction(automation, contactId, subaccountId, slug, vars) {
  const contact = await contactsLib.getContactByIdWithPHI(subaccountId, contactId);
  if (!contact) return { status: 'failed', error: 'Contact not found' };

  switch (automation.action_type) {
    case 'send_email':  return actionSendEmail(automation, contact, slug, vars);
    case 'send_sms':    return actionSendSms(automation, contact, slug, vars);
    case 'add_tag':     return actionAddTag(automation, contact, subaccountId);
    case 'remove_tag':  return actionRemoveTag(automation, contact, subaccountId);
    default:            return { status: 'failed', error: 'Unknown action type: ' + automation.action_type };
  }
}

module.exports = { runAction };
