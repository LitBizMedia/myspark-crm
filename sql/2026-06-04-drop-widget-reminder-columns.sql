-- 2026-06-04  Drop dead per-widget reminder/confirmation columns from service_widgets
--
-- Context: commit a554a19 consolidated all send decisions to the global
-- notification catalog. After that, these four columns were inert: no UI wrote
-- them, the reminder cron ignored them, booking-submit sends confirmations
-- unconditionally, and the upsert Lambda hardcoded them to constants.
-- Verified: all live widgets held defaults, no code read them.
--
-- Applied to production via myspark-audit-db on 2026-06-04. This file is the record.

ALTER TABLE service_widgets DROP COLUMN IF EXISTS send_confirmation_email;
ALTER TABLE service_widgets DROP COLUMN IF EXISTS send_reminder_email;
ALTER TABLE service_widgets DROP COLUMN IF EXISTS reminder_hours_before;
ALTER TABLE service_widgets DROP COLUMN IF EXISTS send_reminder_sms;
