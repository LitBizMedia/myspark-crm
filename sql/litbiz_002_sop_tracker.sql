-- LitBiz SOP Tracker, Stage 2
-- Service-driven SOP system: clients have services, services have tasks,
-- task completion auto-resets on cadence rollover.

BEGIN;

CREATE TABLE IF NOT EXISTS litbiz_sop_clients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subaccount_id         TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  linked_subaccount_id  TEXT REFERENCES subaccounts(id) ON DELETE SET NULL,
  services              JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_due_day        SMALLINT CHECK (report_due_day IS NULL OR (report_due_day BETWEEN 1 AND 31)),
  archived              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_litbiz_sop_clients_subaccount
  ON litbiz_sop_clients(subaccount_id, archived);

CREATE TABLE IF NOT EXISTS litbiz_sop_task_state (
  client_id     UUID NOT NULL REFERENCES litbiz_sop_clients(id) ON DELETE CASCADE,
  task_key      TEXT NOT NULL,
  done_date     DATE,
  done_by       UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_litbiz_sop_task_state_client
  ON litbiz_sop_task_state(client_id);

COMMIT;
