// POST /api/subaccount/contact-find-or-create
//
// Atomic dedup-or-insert. Looks up by email first, then phone, then creates
// if neither found. Replaces the pattern of db.contacts.find() + createContact()
// scattered across frontend and other Lambdas.
//
// Body (JSON):
//   { email, phone, first_name, last_name, name, source, sms_consent_transactional, sms_consent_source }
//   At least one of email or phone is required.
//
// Response:
//   { contact: {...full contact shape...}, was_created: bool, matched_by: 'email' | 'phone' | null }
//
// Audit: logs was_created, matched_by, source. Never logs PII (email/phone values).

const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { findOrCreateContact } = require('./lib/contacts');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};

  // Validate at least one identifier
  if (!body.email && !body.phone) {
    return res.status(400).json({ error: 'At least one of email or phone is required' });
  }

  try {
    const result = await findOrCreateContact(subaccountId, {
      email: body.email,
      phone: body.phone,
      name: body.name || ((body.first_name || '') + ' ' + (body.last_name || '')).trim(),
      first_name: body.first_name,
      last_name: body.last_name,
      source: body.source || 'manual',
      sms_consent_transactional: !!body.sms_consent_transactional,
      sms_consent_source: body.sms_consent_source
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: result.was_created ? 'subaccount.contact.create' : 'subaccount.contact.find',
      targetType: 'contact',
      targetId: result.contact.id,
      targetSubaccountId: subaccountId,
      metadata: {
        was_created: result.was_created,
        matched_by: result.matched_by,
        source: body.source || 'manual',
        has_email: !!body.email,
        has_phone: !!body.phone
      }
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('contact-find-or-create error:', err);
    return res.status(500).json({ error: 'Failed to find or create contact', detail: err.message });
  }
}

exports.handler = wrap(handler);
