-- 2026-06-04  Email logging: category-2 internal sends + provider-neutral rename
--
-- Context: subaccount-scope sends with no contactId (staff notifications like
-- form-submission alerts) were falling through mailgun.js logResult into
-- agency_email_log, the wrong table. This adds a proper home for them and
-- renames the resend-era column on agency_email_log to a provider-neutral name.
--
-- Applied to production via myspark-audit-db on 2026-06-04. This file is the record.

CREATE TABLE IF NOT EXISTS subaccount_email_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  recipient_email TEXT,
  from_email      TEXT,
  subject         TEXT,
  source          TEXT,
  provider_message_id TEXT,
  status          TEXT,
  error_message   TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subaccount_email_log_sub_sent
  ON subaccount_email_log (subaccount_id, sent_at DESC);

ALTER TABLE agency_email_log
  RENAME COLUMN resend_email_id TO provider_message_id;
