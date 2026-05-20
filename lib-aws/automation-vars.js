// lib/automation-vars.js
// Variable substitution for automation messages.
// Syntax: {{namespace.field}}
//
// Available namespaces by trigger type:
//   - always: contact.*, business.*
//   - appointment triggers: + appointment.*
//   - payment triggers: + payment.*
//   - form triggers: + form.*
//
// Missing values render as empty string (never "undefined" or "null").

const db = require('./db');
const contactsLib = require('./contacts');

function formatDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '';
  return '$' + Number(n).toFixed(2);
}

async function buildContactVars(subaccountId, contactId) {
  const c = await contactsLib.getContactByIdWithPHI(subaccountId, contactId);
  if (!c) return {};
  return {
    first_name: c.firstName || c.first_name || '',
    last_name: c.lastName || c.last_name || '',
    display_name: c.displayName || c.display_name || '',
    email: c.email || '',
    phone: c.phone || ''
  };
}

async function buildBusinessVars(subaccountId) {
  const r = await db.query(
    'SELECT s.name AS business_name, s.id, sd.data ' +
    'FROM subaccounts s LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.id ' +
    'WHERE s.id = $1',
    [subaccountId]
  );
  if (r.rows.length === 0) return {};
  const row = r.rows[0];
  const settings = (row.data && row.data.settings) || {};
  return {
    name: settings.businessName || row.business_name || '',
    phone: settings.businessPhone || '',
    email: settings.businessEmail || '',
    address: settings.businessAddress || '',
    website: settings.businessWebsite || ''
  };
}

function buildAppointmentVars(context) {
  if (!context.appointmentDate && !context.serviceName) return {};
  return {
    date: formatDate(context.appointmentDate),
    time: formatTime(context.appointmentDate),
    service_name: context.serviceName || '',
    staff_name: context.staffName || '',
    duration: context.duration || '',
    status: context.appointmentStatus || ''
  };
}

function buildPaymentVars(context) {
  if (context.amount == null) return {};
  return {
    amount: fmtCurrency(context.amount),
    method: context.paymentMethod || '',
    items: context.itemsSummary || ''
  };
}

function buildFormVars(context) {
  if (!context.formId) return {};
  return {
    name: context.formName || '',
    submitted_at: formatDate(context.formSubmittedAt)
  };
}

async function buildVarsForContext(triggerType, context, subaccountId) {
  const bag = {
    contact: await buildContactVars(subaccountId, context.contactId),
    business: await buildBusinessVars(subaccountId)
  };

  if (triggerType === 'appointment_booked' ||
      triggerType === 'appointment_status_changed' ||
      triggerType === 'days_before_appointment' ||
      triggerType === 'days_after_appointment' ||
      triggerType === 'days_after_first_booking' ||
      triggerType === 'days_after_last_booking' ||
      triggerType === 'class_registration_completed') {
    bag.appointment = buildAppointmentVars(context);
  }
  if (triggerType === 'payment_received') {
    bag.payment = buildPaymentVars(context);
  }
  if (triggerType === 'form_submitted') {
    bag.form = buildFormVars(context);
  }
  return bag;
}

// Registry for the UI editor (session 4).
const VAR_REGISTRY = {
  always: [
    'contact.first_name', 'contact.last_name', 'contact.display_name',
    'contact.email', 'contact.phone',
    'business.name', 'business.phone', 'business.email', 'business.address', 'business.website'
  ],
  appointment: [
    'appointment.date', 'appointment.time', 'appointment.service_name',
    'appointment.staff_name', 'appointment.duration', 'appointment.status'
  ],
  payment: ['payment.amount', 'payment.method', 'payment.items'],
  form: ['form.name', 'form.submitted_at']
};

function availableVarsFor(triggerType) {
  const out = VAR_REGISTRY.always.slice();
  if (triggerType.indexOf('appointment') !== -1 ||
      triggerType === 'class_registration_completed' ||
      triggerType === 'days_after_first_booking' ||
      triggerType === 'days_after_last_booking') {
    out.push.apply(out, VAR_REGISTRY.appointment);
  }
  if (triggerType === 'payment_received') out.push.apply(out, VAR_REGISTRY.payment);
  if (triggerType === 'form_submitted') out.push.apply(out, VAR_REGISTRY.form);
  return out;
}

function substituteVars(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/gi, function(match, ns, key) {
    const namespace = vars[ns];
    if (!namespace) return '';
    const v = namespace[key];
    return (v == null) ? '' : String(v);
  });
}

module.exports = {
  buildVarsForContext,
  substituteVars,
  availableVarsFor,
  VAR_REGISTRY
};
