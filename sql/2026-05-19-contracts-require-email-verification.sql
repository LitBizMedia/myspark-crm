-- Per-template opt-in for email verification (HIPAA-stakes templates)
ALTER TABLE contract_templates
  ADD COLUMN IF NOT EXISTS require_email_verification BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contract_envelopes
  ADD COLUMN IF NOT EXISTS require_email_verification BOOLEAN NOT NULL DEFAULT FALSE;
