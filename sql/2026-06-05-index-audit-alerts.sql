-- Sentinel table for the index-size-watch cron.
-- One row per table that has crossed the row-count threshold, so the
-- alarm fires on the crossing and never nags again. Same idempotency
-- discipline as trial_reminder_sent_at and square_webhook_events.

CREATE TABLE IF NOT EXISTS index_audit_alerts (
  table_name   TEXT PRIMARY KEY,
  row_count    BIGINT NOT NULL,
  threshold    BIGINT NOT NULL,
  alerted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
