// lib-aws/notifications-catalog.js
//
// Source of truth for all automated notification types in MySpark+.
// Last full rewrite: 2026-05-22 to match the locked patient-first product spec.
//
// FIELDS per row:
//   key            - stable identifier. Snake_case. NEVER changes after launch.
//   scope          - 'subaccount' | 'agency' | 'system'
//                    subaccount: configured in clinic admin Notifications tab
//                    agency:    configured in agency dashboard (future)
//                    system:    never user-configurable (transactional)
//   audience       - 'patient' | 'admin' | 'internal'
//                    patient:  sent to clinic's patients
//                    admin:    sent to clinic admin (system + agency scopes)
//                    internal: shown on staff dashboard, no channels
//   category       - groups in the UI (Appointments, Payments, etc.)
//   channels       - default channels available (e.g. ['email', 'sms'])
//   default_email  - whether email is on by default
//   default_sms    - whether SMS is on by default
//   default_timing_minutes_before - integer minutes, or null for on-event
//   status         - 'live' | 'planned' (Coming Soon vs functioning sender)
//   template_type  - email_templates.template_type slug, or null
//   label          - human-readable name for the UI
//   description    - one-line explanation for admins
//   source_filters - OPTIONAL. When present, the UI renders sub-checkboxes
//                    so admin can pick WHICH source events trigger this type.
//                    Example: payment_receipt fires for POS + appointment +
//                    recurring billing + gift card + session pack + product.
//                    Admin picks which subset they want.

const CATALOG = [
  // =====================================================================
  // SUBACCOUNT SCOPE - rendered in clinic admin Notifications tab
  // =====================================================================

  // ============ APPOINTMENTS (patient) ============
  // Covers all booking sources: staff calendar, service widget, appointment
  // widget, class widget. The catalog has 4 rows (one per event), each
  // applies to every booking source.
  { key: 'appointment_confirmation', scope: 'subaccount', audience: 'patient', category: 'Appointments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-confirmation', label: 'Appointment Confirmation', description: 'Sent when an appointment is booked, regardless of booking source' },
  { key: 'appointment_reminder', scope: 'subaccount', audience: 'patient', category: 'Appointments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: 1440, status: 'live', template_type: 'appt-reminder', label: 'Appointment Reminder', description: 'Reminds patients before their appointment or class' },
  { key: 'appointment_cancellation', scope: 'subaccount', audience: 'patient', category: 'Appointments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-cancel', label: 'Appointment Cancellation', description: 'Sent when an appointment or class is cancelled' },
  { key: 'appointment_reschedule', scope: 'subaccount', audience: 'patient', category: 'Appointments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'appt-reschedule', label: 'Appointment Reschedule', description: 'Sent when an appointment is rescheduled' },
  { key: 'class_enrollment', scope: 'subaccount', audience: 'patient', category: 'Appointments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'class-enrollment', label: 'Class Enrollment', description: 'Confirms registration when a patient signs up for a class session. Class cancellation and reminders use the Appointment Cancellation and Reminder settings above.' },

  // ============ PAYMENTS (patient) ============
  // payment_receipt has source_filters because one event type (receipt) fires
  // from many sources. Admin picks which to send.
  {
    key: 'payment_receipt', scope: 'subaccount', audience: 'patient', category: 'Payments',
    channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null,
    status: 'live', template_type: 'payment-receipt',
    label: 'Payment Receipt',
    description: 'Receipt sent to a patient after they pay. Choose which payment sources send a receipt.',
    source_filters: {
      available: [
        { key: 'pos',               label: 'POS Transactions',         default: true },
        { key: 'appointment',       label: 'Appointment Payments',     default: true },
        { key: 'recurring_billing', label: 'Recurring Billing Charges', default: true },
        { key: 'gift_card',         label: 'Gift Card Purchases',      default: true },
        { key: 'session_pack',      label: 'Session Pack Purchases',   default: true }
      ]
    }
  },
  { key: 'refund_receipt', scope: 'subaccount', audience: 'patient', category: 'Payments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'refund-receipt', label: 'Refund Receipt', description: 'Confirms to a patient that they have been refunded' },
  { key: 'gift_card_purchase', scope: 'subaccount', audience: 'patient', category: 'Payments', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'gift-card-purchase', label: 'Gift Card Purchase', description: 'Delivers a gift card code. Routes automatically to recipient if set, otherwise buyer.' },
  { key: 'session_pack_low_balance', scope: 'subaccount', audience: 'patient', category: 'Payments', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'session-pack-low', label: 'Session Pack Low Balance', description: 'Warns a patient when their session pack is running low (default threshold: 2 remaining)' },

  // ============ RECURRING BILLING (patient) ============
  // Subaccount admin sets up recurring billing for patients in the Payments
  // tab under Subscriptions. These notifications go to the patient.
  { key: 'recurring_billing_enrollment', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-enrollment', label: 'Enrollment Confirmation', description: 'Welcome message when a patient enrolls in recurring billing' },
  { key: 'recurring_billing_upcoming_charge', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: 4320, status: 'live', template_type: 'recurring-upcoming', label: 'Upcoming Charge Reminder', description: 'Reminds a patient before their card will be charged' },
  { key: 'recurring_billing_payment_failed', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-failed', label: 'Recurring Charge Failed', description: 'Alerts a patient when their recurring charge fails' },
  { key: 'recurring_billing_suspended', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-suspended', label: 'Recurring Billing Suspended', description: 'Notifies a patient when their recurring billing is suspended due to failed payments' },
  { key: 'recurring_billing_paused', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-paused', label: 'Recurring Billing Paused', description: 'Notifies a patient that their recurring billing has been paused' },
  { key: 'recurring_billing_resumed', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-resumed', label: 'Recurring Billing Resumed', description: 'Notifies a patient when their recurring billing resumes' },
  { key: 'recurring_billing_cancelled', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'recurring-cancelled', label: 'Recurring Billing Cancelled', description: 'Confirms to a patient that their recurring billing has been cancelled' },
  { key: 'recurring_billing_trial_ending', scope: 'subaccount', audience: 'patient', category: 'Subscriptions', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: 4320, status: 'live', template_type: 'subscription-trial-reminder', label: 'Trial Ending Soon', description: 'Reminds a patient their trial is ending and a charge is coming' },

  // ============ CONTRACTS (patient) ============
  { key: 'contract_sent', scope: 'subaccount', audience: 'patient', category: 'Contracts', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'contract_signing_request', label: 'Contract Sent', description: 'Delivers a contract to a patient for signature' },
  { key: 'contract_signed', scope: 'subaccount', audience: 'patient', category: 'Contracts', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'contract-signed', label: 'Contract Signed Confirmation', description: 'Confirms to a patient that their signed contract was received' },
  { key: 'contract_receipt', scope: 'subaccount', audience: 'patient', category: 'Contracts', channels: ['email', 'sms'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'contract-receipt', label: 'Contract Receipt', description: 'Receipt for a contract that included payment (requires contract-with-payment feature)' },

  // ============ MARKETING (patient) ============
  { key: 'welcome_new_patient', scope: 'subaccount', audience: 'patient', category: 'Marketing', channels: ['email', 'sms'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'welcome', label: 'Welcome New Patient', description: 'Sent automatically when a new patient is created' },
  { key: 'review_request', scope: 'subaccount', audience: 'patient', category: 'Marketing', channels: ['email', 'sms'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'review-request', label: 'Review Request', description: 'Asks for a review after an appointment' },
  { key: 'no_show_followup', scope: 'subaccount', audience: 'patient', category: 'Marketing', channels: ['email', 'sms'], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'planned', template_type: 'no-show-followup', label: 'No-Show Follow-up', description: 'Gentle re-engagement after a missed appointment' },

  // ============ INTERNAL (staff dashboard) ============
  { key: 'internal_overdue_tasks', scope: 'subaccount', audience: 'internal', category: 'Internal', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Overdue Tasks', description: 'Dashboard alert for overdue tasks' },
  { key: 'internal_tasks_due_today', scope: 'subaccount', audience: 'internal', category: 'Internal', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Tasks Due Today', description: 'Dashboard alert for tasks due today' },
  { key: 'internal_tasks_due_tomorrow', scope: 'subaccount', audience: 'internal', category: 'Internal', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Tasks Due Tomorrow', description: 'Dashboard alert for tasks due tomorrow' },
  { key: 'internal_appointments_today', scope: 'subaccount', audience: 'internal', category: 'Internal', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Appointments Today', description: "Dashboard alert for today's appointments" },
  { key: 'internal_appointments_tomorrow', scope: 'subaccount', audience: 'internal', category: 'Internal', channels: [], default_email: false, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Appointments Tomorrow', description: "Dashboard alert for tomorrow's appointments" },

  // =====================================================================
  // AGENCY SCOPE - configured in future agency dashboard, NOT in subaccount UI
  // These are LitBiz Media (the platform vendor) billing the subaccount admin
  // for their MySpark+ SaaS subscription. Different from patient recurring billing.
  // =====================================================================
  { key: 'subscription_charge_success', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'SaaS Subscription Charged', description: 'Confirmation when a subaccount SaaS subscription successfully charges' },
  { key: 'subscription_receipt', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'receipt', label: 'SaaS Subscription Receipt', description: 'Detailed receipt for SaaS subscription payment' },
  { key: 'subscription_past_due', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'past_due', label: 'SaaS Subscription Past Due', description: 'Alerts admin when SaaS subscription payment is past due' },
  { key: 'subscription_payment_failed', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'payment_failed', label: 'SaaS Subscription Payment Failed', description: 'Alerts admin when a SaaS charge attempt fails' },
  { key: 'subscription_suspended', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'suspended', label: 'SaaS Subscription Suspended', description: 'Notifies admin when SaaS subscription is suspended' },
  { key: 'subscription_trial_ending', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: 4320, status: 'live', template_type: 'trial_ending_soon', label: 'SaaS Trial Ending Soon', description: 'Reminds admin their MySpark+ trial is about to end' },
  { key: 'subscription_cancelled', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'cancellation_confirmed', label: 'SaaS Subscription Cancelled', description: 'Confirms MySpark+ subscription cancellation' },
  { key: 'subscription_reactivated_charged', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'reactivation_confirmed', label: 'SaaS Subscription Reactivated', description: 'Confirms MySpark+ reactivation with a charge' },
  { key: 'subscription_reactivated_no_charge', scope: 'agency', audience: 'admin', category: 'SaaS Billing', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: 'reactivation_no_charge', label: 'SaaS Subscription Reactivated (No Charge)', description: 'Confirms MySpark+ reactivation when no immediate charge needed' },

  // =====================================================================
  // SYSTEM SCOPE - transactional, never user-configurable
  // =====================================================================
  { key: 'password_reset', scope: 'system', audience: 'admin', category: 'Auth', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Password Reset', description: 'Sends password reset link to a user' },
  { key: 'email_domain_grace_warning', scope: 'system', audience: 'admin', category: 'System', channels: ['email'], default_email: true, default_sms: false, default_timing_minutes_before: null, status: 'live', template_type: null, label: 'Email Domain Verification', description: 'Warns admin about pending email domain verification' }
];

// Quick-lookup map by key
const BY_KEY = Object.fromEntries(CATALOG.map(t => [t.key, t]));

// ===== Lookup helpers =====
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

// ===== Audience filters =====
function getPatientTypes() {
  return CATALOG.filter(t => t.audience === 'patient');
}

function getAdminTypes() {
  return CATALOG.filter(t => t.audience === 'admin');
}

function getInternalTypes() {
  return CATALOG.filter(t => t.audience === 'internal');
}

// Deprecated: 'customer' is the old name for patient + admin combined.
// Kept for backward compatibility. New code should use getPatientTypes etc.
function getCustomerTypes() {
  return CATALOG.filter(t => t.audience === 'patient' || t.audience === 'admin');
}

// ===== Scope filters =====
function getSubaccountScopedTypes() {
  return CATALOG.filter(t => t.scope === 'subaccount');
}

function getAgencyScopedTypes() {
  return CATALOG.filter(t => t.scope === 'agency');
}

function getSystemScopedTypes() {
  return CATALOG.filter(t => t.scope === 'system');
}

// ===== Status filters =====
function getLiveTypes() {
  return CATALOG.filter(t => t.status === 'live');
}

function getPlannedTypes() {
  return CATALOG.filter(t => t.status === 'planned');
}

module.exports = {
  CATALOG,
  getType,
  getAllTypes,
  getTypesByCategory,
  getPatientTypes,
  getAdminTypes,
  getInternalTypes,
  getCustomerTypes,
  getSubaccountScopedTypes,
  getAgencyScopedTypes,
  getSystemScopedTypes,
  getLiveTypes,
  getPlannedTypes
};
