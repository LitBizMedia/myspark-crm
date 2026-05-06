-- Migration: SOAP notes table
-- Created: 2026-05-06
-- Purpose: Medical SOAP (Subjective, Objective, Assessment, Plan) notes per contact.
-- Notes can be standalone or linked to a specific appointment.
--
-- Locking model:
--   - Notes auto-lock 24 hours after created_at (computed at read time, not stored)
--   - Notes can also be manually signed via signed_at (becomes locked immediately)
--   - Locked notes cannot be edited; amendments append to amendments JSONB array
--   - Authors and admins can edit unlocked notes
--   - Only admins can amend locked notes
--
-- Audit logging happens at the Lambda layer for all reads, writes, and amendments.

CREATE TABLE IF NOT EXISTS soap_notes (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,

  -- Required references. contact_id is not FK-constrained because contacts
  -- are still in the blob (Path D contacts migration is pending). Once
  -- contacts move to RDS, we can add the FK constraint.
  contact_id TEXT NOT NULL,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  author_id TEXT,

  -- SOAP fields. Stored as TEXT, not VARCHAR, so there's no length cap.
  -- Defaults to empty string so a partial save doesn't blow up.
  subjective TEXT NOT NULL DEFAULT '',
  objective  TEXT NOT NULL DEFAULT '',
  assessment TEXT NOT NULL DEFAULT '',
  plan       TEXT NOT NULL DEFAULT '',

  -- Visit metadata. visit_date is the date of the encounter, which may
  -- differ from created_at (provider writes notes after the visit).
  visit_date    DATE,
  template_used TEXT,

  -- Locking. signed_at being non-null means the provider signed it
  -- (immediate lock). Notes also auto-lock after 24h via API logic.
  signed_at  TIMESTAMPTZ,

  -- Amendments are appended after lock. Each amendment records the author,
  -- timestamp, and what they added. Original SOAP fields are immutable.
  -- Shape: [{ id, author_id, author_name, content, reason, created_at }]
  amendments JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_soap_notes_contact     ON soap_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_soap_notes_subaccount  ON soap_notes(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_soap_notes_appointment ON soap_notes(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_soap_notes_author      ON soap_notes(author_id) WHERE author_id IS NOT NULL;
