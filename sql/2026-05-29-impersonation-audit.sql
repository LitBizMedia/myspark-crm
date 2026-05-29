-- Migration: Add impersonation tracking columns for HIPAA-compliant audit logs
-- Date: 2026-05-29
-- Phase 3 of Agency Workspace Consolidation

BEGIN;

-- sessions table: tracks who is impersonating, if anyone
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS impersonated_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS impersonated_by_username TEXT,
  ADD COLUMN IF NOT EXISTS impersonated_by_user_type TEXT;

-- audit_log table: mirrors the impersonation columns so every audit row
-- carries the real human accountable, not just the impersonated identity
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS impersonated_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS impersonated_by_username TEXT,
  ADD COLUMN IF NOT EXISTS impersonated_by_user_type TEXT;

-- Index for querying audit log by impersonator
CREATE INDEX IF NOT EXISTS idx_audit_log_impersonated_by
  ON audit_log (impersonated_by_user_id, created_at DESC)
  WHERE impersonated_by_user_id IS NOT NULL;

COMMIT;
