-- Migration 02: User ID Unification
-- Date: 2026-05-02
-- Closes forward-path Section 3.8 (JSON-blob-vs-users-table sync gap)
--
-- BEFORE: Three different ID systems for staff:
--   - 'admin-patrick' / 'admin-<slug>' (synthetic admin from getEffectiveAdmin)
--   - 'mobmfim698tcac8jqyn' (random blob user IDs from db.users array)
--   - UUIDs (subaccount_users.id - the auth table)
--
-- AFTER: Single source of truth. All staff IDs are subaccount_users UUIDs.
-- Schedule and date_overrides moved from blob to subaccount_users table.
--
-- This was executed via Lambda (myspark-api-admin-inspect-schema) on 2026-05-02.
-- The Lambda code performed:
--   1. ALTER TABLE subaccount_users ADD schedule JSONB, date_overrides JSONB
--   2. Built mapping legacy_id -> uuid by matching usernames
--   3. UPDATE subaccount_users SET schedule, date_overrides FROM blob.users
--   4. UPDATE appointments.assigned_to with new UUIDs
--   5. UPDATE services.assigned_staff JSONB arrays with new UUIDs
--   6. UPDATE class_sessions.instructor_id (no rows existed)

ALTER TABLE subaccount_users
  ADD COLUMN IF NOT EXISTS schedule JSONB,
  ADD COLUMN IF NOT EXISTS date_overrides JSONB;
