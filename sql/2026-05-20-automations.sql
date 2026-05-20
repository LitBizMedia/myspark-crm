-- Automation engine session 1: schema foundation
-- Adds email_marketing_consent columns to contacts
-- Creates automations + automation_runs tables

BEGIN;

ALTER TABLE contacts
  ADD COLUMN email_marketing_consent BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN email_marketing_consent_updated_at TIMESTAMPTZ,
  ADD COLUMN email_marketing_consent_source TEXT;

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'contact_birthday',
    'contact_age_days',
    'tag_age_days',
    'days_before_appointment',
    'days_after_appointment',
    'days_after_first_booking',
    'days_after_last_booking',
    'contact_created',
    'contact_tagged',
    'appointment_booked',
    'appointment_status_changed',
    'payment_received',
    'form_submitted',
    'class_registration_completed'
  )),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'send_email',
    'send_sms',
    'add_tag',
    'remove_tag'
  )),
  action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_rule TEXT NOT NULL DEFAULT 'once_per_target' CHECK (idempotency_rule IN (
    'once_ever',
    'once_per_target',
    'once_per_year',
    'once_per_period'
  )),
  idempotency_window_days INTEGER,
  is_transactional BOOLEAN NOT NULL DEFAULT FALSE,
  total_runs INTEGER NOT NULL DEFAULT 0,
  last_ran_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID
);

CREATE INDEX idx_automations_subaccount_active
  ON automations(subaccount_id, active)
  WHERE active = true;

CREATE INDEX idx_automations_trigger_type
  ON automations(subaccount_id, trigger_type)
  WHERE active = true;

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  target_ref TEXT NOT NULL DEFAULT '',
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN (
    'success',
    'skipped_consent_sms',
    'skipped_consent_email',
    'skipped_suppressed',
    'skipped_no_contact_info',
    'failed'
  )),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX uniq_automation_runs_target
  ON automation_runs(automation_id, contact_id, target_ref);

CREATE INDEX idx_automation_runs_automation
  ON automation_runs(automation_id);

CREATE INDEX idx_automation_runs_contact
  ON automation_runs(subaccount_id, contact_id);

CREATE INDEX idx_automation_runs_ran_at
  ON automation_runs(ran_at);

COMMIT;
