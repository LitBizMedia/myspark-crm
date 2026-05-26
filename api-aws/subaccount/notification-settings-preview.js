// POST /api/subaccount/notification-settings/preview
//
// Renders a notification email template for the UI preview button.
//
// Logic:
//   1. Look up custom template in email_templates table (future feature)
//   2. If not found, call the matching lib builder for the type_key
//   3. If no lib builder exists, return placeholder
//
// Body: { type_key }
// Response: { subject, html, source: 'custom_template' | 'builtin' | 'placeholder' }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { getType } = require('./lib/notifications-catalog');
const { getEffectiveSettings } = require('./lib/notifications');

// Sample data used by built-in builders. Designed to look realistic so admin
// can judge layout and copy.
const SAMPLE = {
  clientName: 'Jane Doe',
  patientName: 'Jane Doe',
  contact_name: 'Jane Doe',
  serviceName: 'Initial Consultation',
  appointment_title: 'Initial Consultation',
  appointment_date: 'Friday, June 12',
  appointment_time: '2:30 PM',
  dateStr: 'Friday, June 12',
  timeStr: '2:30 PM',
  staffName: 'Dr. Sarah Smith',
  staff_name: 'Dr. Sarah Smith',
  location: '',
  businessName: 'Your Clinic',
  business_name: 'Your Clinic',
  // refund-receipt
  refundTotal: 75.00,
  cardPortion: 75.00,
  giftCardPortion: 0,
  reason: 'Customer requested',
  originalDate: new Date(Date.now() - 5 * 86400000).toISOString(),
  originalTotal: 125.00,
  newStatus: 'partial_refund',
  // recurring billing
  planName: 'Hosting - Standard',
  amount: 25.00,
  billingCycle: 'monthly',
  nextDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
  timezone: 'America/Indiana/Indianapolis'
};

// Lazy-require lib builders so this Lambda doesn't fail to load if one is missing.
function tryRequire(libPath) {
  try { return require(libPath); } catch (e) { return null; }
}

function renderBuiltin(typeKey) {
  // Appointments
  if (typeKey === 'appointment_confirmation' || typeKey === 'appointment_reschedule') {
    const lib = tryRequire('./lib/appointment-emails');
    if (!lib || !lib.buildHtml) return null;
    const isReschedule = typeKey === 'appointment_reschedule';
    const opts = {
      clientName: SAMPLE.clientName,
      serviceName: SAMPLE.serviceName,
      dateStr: SAMPLE.dateStr,
      timeStr: SAMPLE.timeStr,
      staffName: SAMPLE.staffName,
      location: SAMPLE.location,
      businessName: SAMPLE.businessName,
      rescheduleFromDateStr: isReschedule ? 'Thursday, June 11' : null,
      rescheduleFromTimeStr: isReschedule ? '1:00 PM' : null
    };
    return {
      subject: isReschedule
        ? ('Appointment Rescheduled: ' + SAMPLE.serviceName + ' on ' + SAMPLE.dateStr)
        : ('Appointment Confirmed: ' + SAMPLE.serviceName + ' on ' + SAMPLE.dateStr),
      html: lib.buildHtml(opts)
    };
  }

  if (typeKey === 'appointment_reminder') {
    const lib = tryRequire('./lib/reminder-email');
    if (!lib || !lib.buildHtml) return null;
    const vars = {
      contact_name: SAMPLE.contact_name,
      appointment_title: SAMPLE.appointment_title,
      appointment_date: SAMPLE.appointment_date,
      appointment_time: SAMPLE.appointment_time,
      staff_name: SAMPLE.staff_name,
      business_name: SAMPLE.business_name
    };
    return {
      subject: lib.buildSubject(vars),
      html: lib.buildHtml(vars)
    };
  }

  // Refund
  if (typeKey === 'refund_receipt') {
    const lib = tryRequire('./lib/refund-email');
    if (!lib || !lib.buildHtml) return null;
    return {
      subject: lib.buildSubject(SAMPLE),
      html: lib.buildHtml(SAMPLE)
    };
  }

  // Recurring billing: 7 events map to the same lib with different eventType
  const RB_MAP = {
    recurring_billing_enrollment:      'enrollment',
    recurring_billing_upcoming_charge: 'upcoming_charge',
    recurring_billing_payment_failed:  'payment_failed',
    recurring_billing_suspended:       'suspended',
    recurring_billing_paused:          'paused',
    recurring_billing_resumed:         'resumed',
    recurring_billing_cancelled:       'cancelled'
  };
  if (RB_MAP[typeKey]) {
    const lib = tryRequire('./lib/recurring-billing-email');
    if (!lib || !lib.buildHtml) return null;
    const eventType = RB_MAP[typeKey];
    return {
      subject: lib.buildSubject(eventType, SAMPLE),
      html: lib.buildHtml(eventType, SAMPLE)
    };
  }

  // trial_ending uses recurring-billing-email too once we expose its template,
  // but trial_ending currently lives in subscriptions-charge.js cron inline.
  // For now it falls through to placeholder.

  return null; // no builder; caller will show placeholder
}

function buildPlaceholder(type) {
  const subject = '(Default template) ' + type.label;
  const html = '<div style="font-family:Arial,sans-serif;max-width:600px;padding:24px;color:#1a1030;">'
    + '<p style="color:#5a4d7a;font-size:13px;margin:0 0 16px;">'
    + 'No template preview available yet for this notification. The system will send a built-in default when this triggers.'
    + '</p>'
    + '<h2 style="color:#6b21ea;">' + type.label + '</h2>'
    + '<p>' + (type.description || '') + '</p>'
    + '</div>';
  return { subject, html };
}

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

  // Source priority:
  //   1. Custom template in email_templates table
  //   2. Built-in lib builder
  //   3. Placeholder
  let subject = '';
  let html = '';
  let source = 'placeholder';

  // Try custom template first
  if (templateType) {
    try {
      const template = await db.findOne('email_templates',
        { subaccount_id: subaccountId, template_type: templateType, enabled: true },
        { select: 'subject, body_html' }
      );
      if (template) {
        subject = applyVars(template.subject || '', SAMPLE);
        html = applyVars(template.body_html || '', SAMPLE);
        source = 'custom_template';
      }
    } catch (e) {
      // fall through to builtin
    }
  }

  // Fall back to built-in lib builder
  if (!html) {
    const built = renderBuiltin(typeKey);
    if (built) {
      subject = built.subject;
      html = built.html;
      source = 'builtin';
    }
  }

  // Final fallback: placeholder
  if (!html) {
    const ph = buildPlaceholder(type);
    subject = ph.subject;
    html = ph.html;
    source = 'placeholder';
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
    metadata: { type_key: typeKey, source: source }
  });

  return res.status(200).json({ subject, html, source, template_type: templateType });
}

exports.handler = wrap(handler);
