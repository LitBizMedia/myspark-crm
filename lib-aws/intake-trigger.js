// lib-aws/intake-trigger.js
//
// Decides WHICH intake forms an event should send, then hands each to the
// dispatcher. Separation of concerns:
//   - intake-trigger: selection ("which forms for this event")
//   - intake-dispatch: delivery ("send this one form to this contact")
//
// THE FORM DECLARES ITS TRIGGER. Every intake form carries
// form.settings.intake.triggerEvent, one of:
//   'service_booking'  - fires on a first qualifying service booking
//   'contact_created'  - fires when a contact is manually created
//   'manual'           - never fires automatically (drawer send only)
// The form's triggerEvent is the authority. A service listing a form in
// services.intake_form_ids only scopes WHICH services count for forms that
// already declared service_booking; it cannot make a manual/contact form fire.
//
// Two entry points:
//   fireIntakeForServiceBooking - service-booking path (booking-submit)
//   fireIntakeForContactCreated - contact-created path (contact-create)
//
// Never throws upward. A form-send failure must not fail the caller.

const db = require('./db');
const { dispatchIntake } = require('./intake-dispatch');

// Read the service's intake_form_ids (JSONB array).
async function getServiceIntakeFormIds(subaccountId, serviceId) {
  if (!serviceId) return [];
  try {
    const r = await db.query(
      `SELECT intake_form_ids FROM services WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
      [serviceId, subaccountId]
    );
    if (!r.rows.length) return [];
    const ids = r.rows[0].intake_form_ids;
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    console.error('intake-trigger: service form ids lookup failed:', e.message);
    return [];
  }
}

// Read the subaccount's forms blob once; return an array of forms.
async function loadForms(subaccountId) {
  try {
    const r = await db.query(
      `SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1`,
      [subaccountId]
    );
    return (r.rows[0] && r.rows[0].data && Array.isArray(r.rows[0].data.forms))
      ? r.rows[0].data.forms : [];
  } catch (e) {
    console.error('intake-trigger: forms blob load failed:', e.message);
    return [];
  }
}

// Is this form a live intake form for the given trigger event?
// Enforces: enabled master switch, triggerEvent match, active status.
function isLiveIntakeForm(form, triggerEvent) {
  if (!form) return false;
  if (form.status === 'archived' || form.status === 'draft') return false;
  const intake = form.settings && form.settings.intake;
  if (!intake || intake.enabled !== true) return false;
  return intake.triggerEvent === triggerEvent;
}

// Build the dispatcher config for one form, merging form.settings.intake
// over defaults. Contact email/phone come from the caller.
function buildConfigForForm(form, contact) {
  const intake = (form && form.settings && form.settings.intake) || {};
  return {
    formName: (form && form.name) || 'Intake',
    sendEmail: intake.sendEmail !== false,
    sendSms: intake.sendSms !== false,
    emailSubject: intake.emailSubject || '',
    emailMessage: intake.emailMessage || '',
    emailHtml: intake.emailBody || '',
    smsBody: intake.smsBody || '',
    sendFrequency: intake.sendFrequency || 'once',
    periodicDays: (typeof intake.periodicDays === 'number' && intake.periodicDays > 0)
      ? intake.periodicDays : 90,
    linkTtlDays: (typeof intake.linkTtlDays === 'number' && intake.linkTtlDays > 0)
      ? intake.linkTtlDays : undefined,
    contactEmail: contact.email || '',
    contactPhone: contact.phone || '',
    contactName: contact.name || '',
    fromName: contact.bizName || 'MySpark+'
  };
}

// Shared dispatch loop. Sends each given form to the contact.
async function dispatchForms(forms, ctx) {
  const { subaccountId, slug, contactId, appointmentId, contact, triggerEvent } = ctx;
  const results = [];
  for (const form of forms) {
    const config = buildConfigForForm(form, contact || {});
    try {
      const r = await dispatchIntake({
        subaccountId,
        contactId,
        formId: form.id,
        triggerEvent,
        appointmentId: appointmentId || null,
        slug,
        config,
        force: false
      });
      results.push({ formId: form.id, ok: !!(r && r.ok), detail: r });
    } catch (e) {
      console.error('intake-trigger: dispatch threw for form ' + form.id + ':', e.message);
      results.push({ formId: form.id, ok: false, reason: 'dispatch_threw' });
    }
  }
  return results;
}

// ── Entry 1: service-booking path ────────────────────────────────
// A form fires only if BOTH: the booked service lists it in intake_form_ids,
// AND the form itself declared triggerEvent='service_booking' (+ enabled,
// + active, + serviceIds scope empty or including this service).
// opts: { subaccountId, slug, contactId, serviceId, appointmentId, contact }
async function fireIntakeForServiceBooking(opts) {
  const { subaccountId, slug, contactId, serviceId, appointmentId, contact } = opts || {};
  if (!subaccountId || !contactId || !serviceId) return { ok: true, sent: [], reason: 'missing_ids' };

  const listedIds = await getServiceIntakeFormIds(subaccountId, serviceId);
  if (!listedIds.length) return { ok: true, sent: [], reason: 'no_intake_forms_on_service' };

  const forms = await loadForms(subaccountId);
  const byId = {};
  for (const f of forms) if (f && f.id) byId[f.id] = f;

  // Intersect: listed on the service AND declares service_booking AND in scope.
  const selected = [];
  for (const id of listedIds) {
    const form = byId[id];
    if (!isLiveIntakeForm(form, 'service_booking')) continue;
    // Service scope by explicit mode. Backward compat: forms saved before
    // serviceMode existed have no flag; infer 'specific' if serviceIds is
    // populated, else 'all'. 'all' matches any service (including future ones).
    const intake = form.settings.intake;
    const scope = Array.isArray(intake.serviceIds) ? intake.serviceIds : [];
    const mode = intake.serviceMode || (scope.length ? 'specific' : 'all');
    if (mode === 'specific' && scope.indexOf(serviceId) === -1) continue;
    selected.push(form);
  }
  if (!selected.length) return { ok: true, sent: [], reason: 'no_matching_service_forms' };

  const results = await dispatchForms(selected, {
    subaccountId, slug, contactId, appointmentId, contact,
    triggerEvent: 'service_booking'
  });
  return { ok: true, sent: results };
}

// ── Entry: class-registration path ───────────────────────────────
// Fires when someone is registered for a class, from ANY source: the public
// class widget, staff enrollment, or staff scheduling. A class session has a
// parent class-service; forms listed on that service (intake_form_ids) that
// declared triggerEvent='class_registration' fire, subject to service scope.
// opts: { subaccountId, slug, contactId, classSessionId, serviceId, appointmentId, contact }
//   Pass serviceId directly if known (avoids a lookup); else we resolve it
//   from classSessionId.
async function fireIntakeForClassRegistration(opts) {
  const { subaccountId, slug, contactId, classSessionId, appointmentId, contact } = opts || {};
  let serviceId = opts && opts.serviceId;
  if (!subaccountId || !contactId) return { ok: true, sent: [], reason: 'missing_ids' };

  // Resolve the class-service from the session if not provided.
  if (!serviceId && classSessionId) {
    try {
      const r = await db.query(
        `SELECT service_id FROM class_sessions WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
        [classSessionId, subaccountId]
      );
      if (r.rows.length) serviceId = r.rows[0].service_id;
    } catch (e) {
      console.error('intake-trigger: class session service lookup failed:', e.message);
    }
  }
  if (!serviceId) return { ok: true, sent: [], reason: 'no_class_service' };

  const listedIds = await getServiceIntakeFormIds(subaccountId, serviceId);
  if (!listedIds.length) return { ok: true, sent: [], reason: 'no_intake_forms_on_class_service' };

  const forms = await loadForms(subaccountId);
  const byId = {};
  for (const f of forms) if (f && f.id) byId[f.id] = f;

  const selected = [];
  for (const id of listedIds) {
    const form = byId[id];
    if (!isLiveIntakeForm(form, 'class_registration')) continue;
    const intake = form.settings.intake;
    const scope = Array.isArray(intake.serviceIds) ? intake.serviceIds : [];
    const mode = intake.serviceMode || (scope.length ? 'specific' : 'all');
    if (mode === 'specific' && scope.indexOf(serviceId) === -1) continue;
    selected.push(form);
  }
  if (!selected.length) return { ok: true, sent: [], reason: 'no_matching_class_forms' };

  const results = await dispatchForms(selected, {
    subaccountId, slug, contactId, appointmentId, contact,
    triggerEvent: 'class_registration'
  });
  return { ok: true, sent: results };
}

// ── Entry 2: contact-created path ────────────────────────────────
// Fires every form whose triggerEvent='contact_created' (+ enabled + active).
// No service involved. Serves onboarding for non-service businesses.
// opts: { subaccountId, slug, contactId, contact }
async function fireIntakeForContactCreated(opts) {
  const { subaccountId, slug, contactId, contact } = opts || {};
  if (!subaccountId || !contactId) return { ok: true, sent: [], reason: 'missing_ids' };

  const forms = await loadForms(subaccountId);
  const selected = forms.filter(f => isLiveIntakeForm(f, 'contact_created'));
  if (!selected.length) return { ok: true, sent: [], reason: 'no_contact_created_forms' };

  const results = await dispatchForms(selected, {
    subaccountId, slug, contactId, appointmentId: null, contact,
    triggerEvent: 'contact_created'
  });
  return { ok: true, sent: results };
}

module.exports = {
  fireIntakeForServiceBooking,
  fireIntakeForClassRegistration,
  fireIntakeForContactCreated
};
