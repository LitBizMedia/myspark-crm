// lib/twilio.js
// Shared SMS sending helper using Twilio.
// Uses RDS for logging and settings lookup.
// Never import this from client-side code. For /api/* only.
//
// MIGRATED: Supabase REST → lib/db.js for SMS settings and SMS log.

const db = require('./db');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function twilioAuth() {
  return 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
}

async function getSmsSettings(subaccountId) {
  try {
    return await db.findOne('sms_settings', { subaccount_id: subaccountId });
  } catch (e) {
    console.error('getSmsSettings error:', e.message);
    return null;
  }
}

async function logSms(subaccountId, fields) {
  const row = {
    subaccount_id: subaccountId,
    to_number:     fields.to,
    from_number:   fields.from,
    body:          fields.body || null,
    template_type: fields.templateType || null,
    twilio_sid:    fields.twilioSid || null,
    status:        fields.status || 'queued',
    error_message: fields.error || null,
    contact_id:    fields.contactId || null
  };
  try {
    await db.insertOne('sms_log', row, { returning: 'id' });
  } catch (e) {
    console.error('logSms error:', e.message);
  }
}

function applyVars(str, vars) {
  if (!str || !vars) return str;
  return Object.keys(vars).reduce(function(result, key) {
    return result.split('{{' + key + '}}').join(vars[key] != null ? String(vars[key]) : '');
  }, str);
}

async function sendSms(slug, opts) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }
  if (!opts || !opts.to) {
    return { ok: false, error: 'to is required' };
  }

  const subaccountId = 'sub-' + slug;
  const settings = await getSmsSettings(subaccountId);

  if (!settings) {
    return { ok: false, error: 'SMS not configured for this workspace' };
  }
  if (!settings.enabled) {
    return { ok: false, error: 'SMS not enabled for this workspace' };
  }
  if (settings.campaign_status !== 'approved') {
    return { ok: false, error: 'SMS campaign not yet approved' };
  }
  if (!settings.twilio_number) {
    return { ok: false, error: 'No Twilio number assigned to this workspace' };
  }

  const fromNumber = settings.twilio_number;
  const body = opts.vars ? applyVars(opts.body, opts.vars) : opts.body;

  if (!body) {
    return { ok: false, error: 'body is required' };
  }

  const params = new URLSearchParams({
    To: opts.to,
    From: fromNumber,
    Body: body
  });

  try {
    const res = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json',
      {
        method: 'POST',
        headers: {
          'Authorization': twilioAuth(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    const data = await res.json();

    if (!res.ok) {
      await logSms(subaccountId, {
        to: opts.to,
        from: fromNumber,
        body: body,
        templateType: opts.templateType,
        contactId: opts.contactId,
        status: 'failed',
        error: data.message || 'Twilio error ' + res.status
      });
      return { ok: false, error: data.message || 'Send failed' };
    }

    await logSms(subaccountId, {
      to: opts.to,
      from: fromNumber,
      body: body,
      templateType: opts.templateType,
      contactId: opts.contactId,
      twilioSid: data.sid,
      status: data.status || 'queued'
    });

    return { ok: true, sid: data.sid };

  } catch (e) {
    console.error('sendSms error:', e.message);
    await logSms(subaccountId, {
      to: opts.to,
      from: fromNumber,
      body: body,
      templateType: opts.templateType,
      contactId: opts.contactId,
      status: 'failed',
      error: e.message
    });
    return { ok: false, error: e.message };
  }
}

module.exports = { sendSms, getSmsSettings };
