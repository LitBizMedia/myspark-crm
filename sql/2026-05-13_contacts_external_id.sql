-- Add external_id to contacts for stable external dedup (e.g. GHL Contact Id).
-- Created May 13, 2026.
--
-- Use cases:
--   - CSV import dedup on external system id (more reliable than email)
--   - Bidirectional sync with external CRMs in the future
--
-- Unique constraint scoped to (subaccount_id, external_id), only when
-- external_id is non-null. Allows multiple contacts without external_id.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_subaccount_external
  ON contacts (subaccount_id, external_id)
  WHERE external_id IS NOT NULL;
