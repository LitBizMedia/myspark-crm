-- Add SMS consent columns to contacts table for A2P 10DLC compliance
-- Captured by form-submit endpoint when consent field is on a form
-- Used by future compliance enforcement (drawer indicators, conversations gating)

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS sms_consent_transactional BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_consent_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_consent_source TEXT;

COMMENT ON COLUMN contacts.sms_consent_transactional IS 'Transactional SMS consent (appointment reminders, account notifications)';
COMMENT ON COLUMN contacts.sms_consent_marketing IS 'Marketing SMS consent (promotions, offers, broadcasts)';
COMMENT ON COLUMN contacts.sms_consent_updated_at IS 'When consent was last captured or updated';
COMMENT ON COLUMN contacts.sms_consent_source IS 'Where consent came from: form_submission, manual, import, etc.';
