// POST /api/subaccount/notification-settings/preview
//
// Renders a notification email template with sample variables for the UI
// preview button. Reads from email_templates table when template_type is
// configured, otherwise falls back to inline catalog defaults if any.
//
// Body: { type_key, sample_vars? }
//
// Response: { subject, html, vars_used }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { getType } = require('./lib/notifications-catalog');
const { getEffectiveSettings } = require('./lib/notifications');

// Sample vars by category, used when admin doesn't supply their own
const SAMPLE_VARS = {
  Appointments: {
    contact_name: 'Sample Patient',
    contact_email: 'patient@example.com',
    contact_phone: '(317) 555-0100',
    appointment_date: 'Tomorrow',
    appointment_time: '2:30 PM',
    appointment_service: 'Consultation',
    staff_name: 'Dr. Smith',
    business_name: 'Your Clinic'
  },
  Booking: {
    contact_name: 'Sample Patient',
    contact_email: 'patient@example.com',
    appointment_date: 'Tomorrow',
    appointment_time: '2:30 PM',
    business_name: 'Your Clinic'
  },
  Billing: {
    subName: 'Premium Plan',
    dollars: '49.00',
    nextBillingDate: 'June 22, 2026'
  },
  Contracts: {
    contact_name: 'Sample Patient',
    business_name: 'Your Clinic',
    contract_title: 'Service Agreement'
  }
};

function applyVars(str, vars) {
  if (!str || !vars) return str;
  return Object.keys(vars).reduce((result, key) => {
    return result.split('{{' + key + '}}').join(vars[key] != null ? String(vars[key]) : '');
  }, str);
}

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  const subaccountId = auth.subaccount_id;

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const typeKey = body.type_key;
  if (!typeKey) return res.status(400).json({ error: 'type_key required' });

  const type = getType(typeKey);
  if (!type) return res.status(400).json({ error: 'Unknown notification type: ' + typeKey });

  const eff = await getEffectiveSettings(subaccountId, typeKey, db);
  const templateType = eff.template_type;

  // Look up the template if configured
  let template = null;
  if (templateType) {
    try {
      template = await db.findOne('email_templates',
        { subaccount_id: subaccountId, template_type: templateType, enabled: true },
        { select: 'subject, body_html' }
      );
    } catch (e) {
      template = null;
    }
  }

  // Sample vars: caller-provided override catalog defaults for that category
  const sampleVars = Object.assign(
    {},
    SAMPLE_VARS[type.category] || SAMPLE_VARS.Appointments,
    body.sample_vars || {}
  );

  let subject = '';
  let html = '';

  if (template) {
    subject = applyVars(template.subject || '', sampleVars);
    html = applyVars(template.body_html || '', sampleVars);
  } else {
    // No custom template configured; show a generic placeholder
    subject = '(Default template) ' + type.label;
    html = '<div style="font-family:Arial,sans-serif;max-width:600px;padding:24px;color:#1a1030;">'
      + '<p style="color:#5a4d7a;font-size:13px;margin:0 0 16px;">'
      + 'No custom template configured for this notification. The system will send a built-in default.'
      + '</p>'
      + '<h2 style="color:#6b21ea;">' + type.label + '</h2>'
      + '<p>' + type.description + '</p>'
      + '<p style="color:#5a4d7a;font-size:13px;margin-top:24px;">'
      + 'To customize this notification, configure a template with template_type = '
      + (templateType || 'none required') + '.'
      + '</p>'
      + '</div>';
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.notification_settings.preview',
    targetType: 'notification_settings',
    targetSubaccountId: subaccountId,
    metadata: { type_key: typeKey, has_custom_template: !!template }
  });

  return res.status(200).json({
    subject,
    html,
    vars_used: sampleVars,
    has_custom_template: !!template,
    template_type: templateType
  });
}

exports.handler = wrap(handler);
