-- Remove tag_age_days from trigger_type CHECK constraint.
-- It was in the original list but dropped from v1 spec.
BEGIN;
ALTER TABLE automations DROP CONSTRAINT automations_trigger_type_check;
ALTER TABLE automations ADD CONSTRAINT automations_trigger_type_check
  CHECK (trigger_type IN (
    'contact_birthday',
    'contact_age_days',
    'days_before_appointment',
    'days_after_appointment',
    'days_after_first_booking',
    'days_after_last_booking',
    'contact_created',
    'contact_tagged',
    'appointment_booked',
    'appointment_status_changed',
    'payment_received',
    'form_submitted',
    'class_registration_completed'
  ));
COMMIT;
