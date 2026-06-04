// api/subaccount/intake-manual-send.js (Lambda)
// POST /api/subaccount/intake-manual-send
//
// Staff-initiated manual send of an intake form to a contact. The human-judgment
// override: a provider decides "this patient needs this form" and sends it on
// demand, regardless of the form's auto-trigger config or send history.
//
// Body (JSON):
//   { contact_id, form_id, channel }  channel: 'email' | 'sms' | 'both' (default 'email')
//
// Uses force=true so the frequency guard (once/periodic) is bypassed: staff can
// send the same form to the same contact as many times as they choose. The send
// is tagged triggerEvent='manual' in the intake_sends log so it's distinguishable
// from automatic sends. The dispatcher builds the attribution token (carries
// contact_id) so the eventual submission attaches to the right contact.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const { dispatchIntake } = require('./lib/intake-dispatch');
const { getContactById } = require('./lib/contacts');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const contactId = body.contact_id;
  const formId = body.form_id;
  let channel = body.channel || 'email';
  if (['email', 'sms', 'both'].indexOf(channel) === -1) channel = 'email';

  if (!contactId || !formId) {
    return res.status(400).json({ error: 'contact_id and form_id are required' });
  }

  try {
    // Load the contact for delivery channels.
    const contact = await getContactById(subaccountId, contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Load the form from the subaccount blob.
    const r = await db.query(
      `SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1`,
      [subaccountId]
    );
    const forms = (r.rows[0] && r.rows[0].data && Array.isArray(r.rows[0].data.forms))
      ? r.rows[0].data.forms : [];
    const form = forms.find(f => f && f.id === formId);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    // Channel choice wins for this send, overriding the form's auto-config.
    const sendEmail = (channel === 'email' || channel === 'both');
    const sendSms = (channel === 'sms' || channel === 'both');

    if (sendEmail && !contact.email) {
      return res.status(400).json({ error: 'Contact has no email address' });
    }
    if (sendSms && !contact.phone) {
      return res.status(400).json({ error: 'Contact has no phone number' });
    }

    const intake = (form.settings && form.settings.intake) || {};
    const config = {
      formName: form.name || 'Form',
      sendEmail,
      sendSms,
      emailSubject: intake.emailSubject || '',
      emailMessage: intake.emailMessage || '',
      emailHtml: intake.emailBody || '',
      smsBody: intake.smsBody || '',
      linkTtlDays: (typeof intake.linkTtlDays === 'number' && intake.linkTtlDays > 0)
        ? intake.linkTtlDays : undefined,
      contactEmail: contact.email || '',
      contactPhone: contact.phone || '',
      contactName: contact.displayName || contact.name || '',
      fromName: 'MySpark+'
    };

    const slug = String(subaccountId).replace(/^sub-/, '');

    const result = await dispatchIntake({
      subaccountId,
      contactId,
      formId,
      triggerEvent: 'manual',
      appointmentId: null,
      slug,
      config,
      force: true
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.intake.manual_send',
      targetType: 'contact',
      targetId: contactId,
      targetSubaccountId: subaccountId,
      metadata: {
        form_id: formId,
        channel,
        intake_id: result && result.intake_id,
        ok: !!(result && result.ok)
      }
    });

    if (!result || !result.ok) {
      return res.status(502).json({ error: 'Send failed', detail: result && result.error });
    }
    return res.status(200).json({
      success: true,
      intake_id: result.intake_id,
      channels: result.channels,
      status: result.status
    });
  } catch (e) {
    console.error('intake-manual-send error:', e.message);
    return res.status(500).json({ error: 'Failed to send form', detail: e.message });
  }
}

exports.handler = wrap(handler);
