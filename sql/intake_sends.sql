CREATE TABLE IF NOT EXISTS intake_sends (
  id              TEXT PRIMARY KEY,
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  contact_id      TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  form_id         TEXT NOT NULL,
  trigger_event   TEXT NOT NULL,
  appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'filled', 'send_failed')),
  channels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  submission_id   TEXT,
  filled_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NOTE: intake_sends is a SEND LOG. There is intentionally NO unique constraint
-- on (subaccount_id, contact_id, form_id): a contact may receive the same form
-- multiple times. The send-frequency policy (once/always/periodic) lives in the
-- dispatcher (lib-aws/intake-dispatch.js shouldSkipByPolicy), not in the schema.
-- The original uq_intake_sends_sub_contact_form constraint was DROPPED on
-- 2026-06-04 when the throttle moved to the policy layer. Append-only writes.

-- Reminder nudge query: unfilled sends past a threshold
CREATE INDEX IF NOT EXISTS idx_intake_sends_status
  ON intake_sends (subaccount_id, status);

-- "Form on file" check: has this contact been sent/filled this form
CREATE INDEX IF NOT EXISTS idx_intake_sends_contact
  ON intake_sends (subaccount_id, contact_id);
