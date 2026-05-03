-- Phase C.1: Buffer persistence on appointments table
-- 2026-05-03
-- Frontend already sends buffer_before/buffer_after in payload; appointments-upsert
-- silently drops them today because columns don't exist. This adds them.
-- Existing rows get default 0. No data backfill needed.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS buffer_before INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buffer_after  INT DEFAULT 0;

-- Sanity check: confirm columns exist
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'appointments'
  AND column_name IN ('buffer_before','buffer_after')
ORDER BY column_name;
