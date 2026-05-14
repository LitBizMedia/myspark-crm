-- 2026-05-14: Expand sms_registration_requests for full A2P data
--
-- The bare-minimum form (business name, EIN, website, contact name/phone/email)
-- isn't enough to register a brand+campaign with Twilio Trust Hub. This
-- migration adds the remaining fields Twilio requires, plus a 'draft' status
-- so clinics can save mid-form and return later.

ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS business_industry TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS business_country TEXT DEFAULT 'US';
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS address_street TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS address_state TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS address_zip TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS contact_first_name TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS contact_last_name TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS contact_title TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS use_case TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS use_case_description TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS sample_message_1 TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS sample_message_2 TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS sample_message_3 TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS opt_in_method TEXT;
ALTER TABLE sms_registration_requests ADD COLUMN IF NOT EXISTS opt_in_description TEXT;

-- Allow 'draft' status for mid-form saves
ALTER TABLE sms_registration_requests DROP CONSTRAINT IF EXISTS sms_registration_requests_status_check;
ALTER TABLE sms_registration_requests
  ADD CONSTRAINT sms_registration_requests_status_check
  CHECK (status = ANY (ARRAY['draft', 'requested', 'in_progress', 'provisioned', 'rejected']));

-- Relax NOT NULL on legacy required fields. The wizard saves drafts mid-flow
-- with partial data; Lambda validates required-on-submit logic instead.
ALTER TABLE sms_registration_requests ALTER COLUMN legal_business_name DROP NOT NULL;
ALTER TABLE sms_registration_requests ALTER COLUMN ein DROP NOT NULL;
ALTER TABLE sms_registration_requests ALTER COLUMN contact_name DROP NOT NULL;
ALTER TABLE sms_registration_requests ALTER COLUMN contact_phone DROP NOT NULL;
