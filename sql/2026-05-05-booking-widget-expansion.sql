-- Booking widget Stage 1: expand service_widgets schema
-- Adds staff selection, payment requirement, round-robin placeholder, intake form,
-- custom confirmation message.

BEGIN;

ALTER TABLE service_widgets
  ADD COLUMN IF NOT EXISTS staff_mode TEXT NOT NULL DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS staff_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS round_robin_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS require_payment BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS intake_form_id TEXT,
  ADD COLUMN IF NOT EXISTS confirm_message TEXT;

-- Add a check constraint on staff_mode (defensive)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_widgets_staff_mode_check'
  ) THEN
    ALTER TABLE service_widgets
      ADD CONSTRAINT service_widgets_staff_mode_check
      CHECK (staff_mode IN ('specific','any','round_robin'));
  END IF;
END $$;

COMMIT;

-- Verify
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'service_widgets'
  AND column_name IN ('staff_mode','staff_ids','round_robin_config','require_payment','intake_form_id','confirm_message')
ORDER BY column_name;
