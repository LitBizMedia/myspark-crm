-- Migration: Add is_agency_admin column to subaccount_users
-- Date: 2026-05-29
-- Phase 1 of Agency Workspace Consolidation

BEGIN;

-- Add column with safe default
ALTER TABLE subaccount_users
  ADD COLUMN IF NOT EXISTS is_agency_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for fast lookup of agency admins
CREATE INDEX IF NOT EXISTS idx_subaccount_users_agency_admin
  ON subaccount_users (subaccount_id)
  WHERE is_agency_admin = TRUE;

-- Backfill: patrick is the only agency admin
UPDATE subaccount_users
SET is_agency_admin = TRUE,
    updated_at = NOW()
WHERE id = '0296b484-64c3-4752-a088-f25faeeb03a5'
  AND subaccount_id = 'sub-litbiz'
  AND username = 'patrick';

-- Sanity check: confirm exactly one row was flagged
DO $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM subaccount_users WHERE is_agency_admin = TRUE;
  IF cnt != 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 agency admin, found %', cnt;
  END IF;
END $$;

COMMIT;
