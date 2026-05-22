// lib-aws/notifications-catalog.js
//
// Source of truth for all automated notification types in MySpark+.
// The DB table subaccount_notification_settings stores PER-SUBACCOUNT
// OVERRIDES of these defaults. If no row exists in the table, the catalog
// default applies. This file is the only place to add a new notification
// type.
//
// Fields:
//   key           - stable identifier, used in DB rows. Snake_case, never changes.
//   label         - human-readable name shown in the UI.
//   description   - one-line explanation for admins.
//   category      - groups in the UI (Appointments, Booking, Billing, etc.)
//   audience      - 'customer' (sends to contacts) or 'internal' (staff dashboard)
//   risk_level    - 'required' | 'recommended' | 'optional'
//                   - required: cannot be disabled in UI (transactional, customer harm if off)
//                   - recommended: can disable, UI warns
//                   - optional: free toggle
//   channels      - default channels available: ['email'], ['sms'], or ['email', 'sms']
//   default_email - whether email is on by default
//   default_sms   - whether SMS is on by default
//   default_timing_minutes_before - integer minutes before event, or null for on-event/on-request sends
//   status        - 'live' (sender exists and respects this type) or 'planned' (sender not yet built)
//   template_type - the email_templates.template_type slug, or null for inline templates

const CATALOG = [
  // ============ APPOINTMENTS ============
  { key: 'appointment_confirmation', label: 'Appointment Confirmation', description: 'Sent when an appointment is created', category: 'Appointments', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-confirmation' },
  { key: 'appointment_reminder', label: 'Appointment Reminder', description: 'Reminds patients before their appointment', category: 'Appointments', audience: 'customer', risk_level: 'optional', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: 1440, status: 'live', template_type: 'appt-reminder' },
  { key: 'appointment_cancel_notification', label: 'Appointment Cancellation', description: 'Sent when an appointment is cancelled', category: 'Appointments', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-cancel' },
  { key: 'appointment_reschedule_notification', label: 'Appointment Reschedule', description: 'Sent when an appointment is rescheduled', category: 'Appointments', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-reschedule' },
  { key: 'appointment_payment_receipt', label: 'Appointment Payment Receipt', description: 'Receipt for appointment payment', category: 'Appointments', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'appt-receipt' },

  // ============ BOOKING WIDGET ============
  { key: 'booking_confirmation', label: 'Booking Confirmation', description: 'Sent after public booking widget submission', category: 'Booking', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'booking-confirmation' },

  // ============ CLASSES ============
  { key: 'class_registration_confirmation', label: 'Class Registration', description: 'Confirms registration for a class session', category: 'Classes', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'class-registration' },
  { key: 'class_session_cancelled', label: 'Class Session Cancelled', description: 'Notifies registered participants when a class is cancelled', category: 'Classes', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'class-cancelled' },

  // ============ POS / SALES ============
  { key: 'pos_payment_receipt', label: 'POS Payment Receipt', description: 'Receipt for in-person POS payment', category: 'Sales', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'pos-receipt' },
  { key: 'gift_card_sale_confirmation', label: 'Gift Card Purchase', description: 'Delivers the gift card code to the buyer', category: 'Sales', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'gift-card-sale' },

  // ============ BILLING (subscription, agency-to-subaccount) ============
  { key: 'subscription_charge_success', label: 'Subscription Charged', description: 'Confirmation when a subscription successfully charges', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'subscription_receipt', label: 'Subscription Receipt', description: 'Detailed receipt for subscription payment', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'receipt' },
  { key: 'subscription_past_due', label: 'Subscription Past Due', description: 'Alerts admin when subscription payment is past due', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'past_due' },
  { key: 'subscription_payment_failed', label: 'Subscription Payment Failed', description: 'Alerts admin when a charge attempt fails', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'payment_failed' },
  { key: 'subscription_suspended', label: 'Subscription Suspended', description: 'Notifies admin when subscription is suspended', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'suspended' },
  { key: 'subscription_trial_ending', label: 'Trial Ending Soon', description: 'Reminds admin their trial is about to end', category: 'Billing', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: 4320, status: 'live', template_type: 'trial_ending_soon' },
  { key: 'subscription_cancelled', label: 'Subscription Cancelled', description: 'Confirms subscription cancellation', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'cancellation_confirmed' },
  { key: 'subscription_reactivated_charged', label: 'Subscription Reactivated', description: 'Confirms reactivation with a charge', category: 'Billing', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'reactivation_confirmed' },
  { key: 'subscription_reactivated_no_charge', label: 'Subscription Reactivated (No Charge)', description: 'Confirms reactivation when no immediate charge needed', category: 'Billing', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'reactivation_no_charge' },

  // ============ AUTH ============
  { key: 'password_reset', label: 'Password Reset', description: 'Sends password reset link to a user', category: 'Auth', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },

  // ============ CONTRACTS ============
  { key: 'contract_sent', label: 'Contract Sent', description: 'Delivers a contract to a client for signature', category: 'Contracts', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'contract-sent' },
  { key: 'contract_signed_notification', label: 'Contract Signed', description: 'Notifies clinic when a contract is signed', category: 'Contracts', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'contract-signed' },
  { key: 'contract_receipt', label: 'Contract Receipt', description: 'Receipt for contract payment', category: 'Contracts', audience: 'customer', risk_level: 'required', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'contract-receipt' },

  // ============ SYSTEM ============
  { key: 'email_domain_grace_warning', label: 'Email Domain Verification', description: 'Warns admin about pending email domain verification', category: 'System', audience: 'customer', risk_level: 'recommended', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },

  // ============ AUTOMATIONS / JOURNEYS ============
  { key: 'journey_email_step', label: 'Journey Email Step', description: 'Email step in an automation journey', category: 'Automations', audience: 'customer', risk_level: 'optional', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'journey_sms_step', label: 'Journey SMS Step', description: 'SMS step in an automation journey', category: 'Automations', audience: 'customer', risk_level: 'optional', channels: ['sms'], default_email: false, default_sms: true, default_timing_minutes_before: null, status: 'live', template_type: null },

  // ============ MARKETING ============
  { key: 'welcome_new_patient', label: 'Welcome New Patient', description: 'Sent automatically when a new contact is created', category: 'Marketing', audience: 'customer', risk_level: 'optional', channels: ['email'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'welcome' },
  { key: 'review_request', label: 'Review Request', description: 'Asks for a review after an appointment', category: 'Marketing', audience: 'customer', risk_level: 'optional', channels: ['email'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'review-request' },
  { key: 'no_show_followup', label: 'No-Show Follow-up', description: 'Gentle re-engagement after a missed appointment', category: 'Marketing', audience: 'customer', risk_level: 'optional', channels: ['email'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'no-show-followup' },

  // ============ INTERNAL (staff dashboard) ============
  { key: 'internal_overdue_tasks', label: 'Overdue Tasks', description: 'Dashboard alert for overdue tasks', category: 'Internal', audience: 'internal', risk_level: 'optional', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'internal_tasks_due_today', label: 'Tasks Due Today', description: 'Dashboard alert for tasks due today', category: 'Internal', audience: 'internal', risk_level: 'optional', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'internal_tasks_due_tomorrow', label: 'Tasks Due Tomorrow', description: 'Dashboard alert for tasks due tomorrow', category: 'Internal', audience: 'internal', risk_level: 'optional', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'internal_appointments_today', label: 'Appointments Today', description: 'Dashboard alert for today\'s appointments', category: 'Internal', audience: 'internal', risk_level: 'optional', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null },
  { key: 'internal_appointments_tomorrow', label: 'Appointments Tomorrow', description: 'Dashboard alert for tomorrow\'s appointments', category: 'Internal', audience: 'internal', risk_level: 'optional', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null }
];

// Quick-lookup map by key
const BY_KEY = Object.fromEntries(CATALOG.map(t => [t.key, t]));

function getType(key) {
  return BY_KEY[key] || null;
}

function getAllTypes() {
  return CATALOG;
}

function getTypesByCategory() {
  const byCategory = {};
  for (const t of CATALOG) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }
  return byCategory;
}

function getCustomerTypes() {
  return CATALOG.filter(t => t.audience === 'customer');
}

function getInternalTypes() {
  return CATALOG.filter(t => t.audience === 'internal');
}

function getLiveTypes() {
  return CATALOG.filter(t => t.status === 'live');
}

module.exports = {
  CATALOG,
  getType,
  getAllTypes,
  getTypesByCategory,
  getCustomerTypes,
  getInternalTypes,
  getLiveTypes
};
