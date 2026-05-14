-- 2026-05-14: SMS Status Simplification
--
-- Consolidate dual-flag (campaign_status + enabled) to single status field
-- with three states: pending, live, paused.
--
-- Rationale:
-- - Removes confusion between two flags that both gate the same thing
-- - 'live' is friendlier than 'approved' for end-user UI
-- - 'paused' replaces the disable-while-approved special case
-- - Rejections no longer have a dedicated state; rejection_note column
--   carries the explanation and status reverts to 'pending' for resubmission
--
-- Migration steps applied via audit-db Lambda:
-- 1. DROP CONSTRAINT sms_settings_campaign_status_check (old)
-- 2. Migrate data:
--    not_registered -> pending
--    approved + enabled=true  -> live
--    approved + enabled=false -> paused
--    rejected -> pending (with rejection_note explanation)
-- 3. ADD COLUMN rejection_note TEXT
-- 4. ADD CONSTRAINT new check (pending, live, paused)
-- 5. SET DEFAULT 'pending'
-- 6. DROP COLUMN enabled

-- Reproducible form (idempotent):
ALTER TABLE sms_settings DROP CONSTRAINT IF EXISTS sms_settings_campaign_status_check;

-- Map old vocabulary onto new (safe re-run guards)
UPDATE sms_settings SET campaign_status = 'pending' WHERE campaign_status = 'not_registered';
UPDATE sms_settings SET campaign_status = 'live'    WHERE campaign_status = 'approved' AND enabled = true;
UPDATE sms_settings SET campaign_status = 'paused'  WHERE campaign_status = 'approved' AND enabled = false;
UPDATE sms_settings
  SET campaign_status = 'pending',
      rejection_note = COALESCE(rejection_note, 'Previous submission was rejected.')
  WHERE campaign_status = 'rejected';

ALTER TABLE sms_settings ADD COLUMN IF NOT EXISTS rejection_note TEXT;
ALTER TABLE sms_settings
  ADD CONSTRAINT sms_settings_campaign_status_check
  CHECK (campaign_status = ANY (ARRAY['pending'::text, 'live'::text, 'paused'::text]));
ALTER TABLE sms_settings ALTER COLUMN campaign_status SET DEFAULT 'pending';
ALTER TABLE sms_settings DROP COLUMN IF EXISTS enabled;
