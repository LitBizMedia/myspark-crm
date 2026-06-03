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
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_intake_sends_sub_contact_form UNIQUE (subaccount_id, contact_id, form_id)
);

-- Reminder nudge query: unfilled sends past a threshold
CREATE INDEX IF NOT EXISTS idx_intake_sends_status
  ON intake_sends (subaccount_id, status);

-- "Form on file" check: has this contact been sent/filled this form
CREATE INDEX IF NOT EXISTS idx_intake_sends_contact
  ON intake_sends (subaccount_id, contact_id);
