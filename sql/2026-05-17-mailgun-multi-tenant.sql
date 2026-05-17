-- 2026-05-17-mailgun-multi-tenant.sql
--
-- Adds Mailgun multi-tenant infrastructure to subaccount_email_domains.
--
-- Changes:
--   1. sending_mode: 'shared' (default) | 'branded'
--   2. grace_period_ends_at: timestamp when grace expires (default 14 days from row creation)
--   3. grace_period_blocked: true once expired AND not verified
--   4. warning_emails_sent: JSONB array of days when warning emails were sent ([7, 10, 13])
--   5. mailgun_sending_key: per-domain Mailgun API key for branded sends
--   6. mailgun_domain_id: Mailgun's internal domain identifier (returned from add domain API)
--   7. mailgun_inbound_route_id: Mailgun route ID for inbound, used for cleanup on remove
--
-- Migration is additive, no data loss. Existing rows get sending_mode='shared'
-- and grace_period_ends_at=NOW()+14 days, which means existing subaccounts have
-- 14 days from migration date to verify their domain or migrate to branded.

BEGIN;

ALTER TABLE subaccount_email_domains
  ADD COLUMN IF NOT EXISTS sending_mode TEXT NOT NULL DEFAULT 'shared'
    CHECK (sending_mode IN ('shared', 'branded')),
  ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  ADD COLUMN IF NOT EXISTS grace_period_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warning_emails_sent JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mailgun_sending_key TEXT,
  ADD COLUMN IF NOT EXISTS mailgun_domain_id TEXT,
  ADD COLUMN IF NOT EXISTS mailgun_inbound_route_id TEXT;

-- Index for the daily grace period check cron
CREATE INDEX IF NOT EXISTS idx_subaccount_email_domains_grace_check
  ON subaccount_email_domains (grace_period_ends_at)
  WHERE grace_period_blocked = FALSE;

COMMIT;

-- Verify
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'subaccount_email_domains'
  AND column_name IN ('sending_mode', 'grace_period_ends_at', 'grace_period_blocked', 'warning_emails_sent', 'mailgun_sending_key', 'mailgun_domain_id', 'mailgun_inbound_route_id')
ORDER BY ordinal_position;
