-- ============================================================================
-- MIGRATION: Contracts feature foundation
-- DATE: May 19, 2026
-- SPEC: docs/MySpark-Contracts-Spec.md
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- contract_templates: reusable template definitions
-- ----------------------------------------------------------------------------
CREATE TABLE contract_templates (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,

  -- Identity
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Content
  body_html TEXT NOT NULL,
  body_plaintext TEXT,

  -- Defaults applied to envelopes when sent
  default_expiration_days INTEGER NOT NULL DEFAULT 30,
  default_signature_required BOOLEAN NOT NULL DEFAULT TRUE,
  default_agree_text TEXT NOT NULL DEFAULT 'I agree to electronically sign this document and confirm that the information provided is accurate.',

  -- Tracking
  send_count INTEGER NOT NULL DEFAULT 0,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contract_templates_subaccount
  ON contract_templates(subaccount_id)
  WHERE active = TRUE;

-- ----------------------------------------------------------------------------
-- contract_envelopes: instances sent to specific contacts
-- ----------------------------------------------------------------------------
CREATE TABLE contract_envelopes (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES contract_templates(id) ON DELETE SET NULL,

  -- Recipient snapshot (legal record, immutable after send)
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,

  -- Sender
  sender_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,

  -- Content snapshot (legal record, immutable after status changes from draft)
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  variables_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  agree_text TEXT NOT NULL,

  -- Status state machine
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'signed', 'expired', 'voided')),

  -- Token (signing access). Hash only, never raw JWT.
  token_hash TEXT,
  expires_at TIMESTAMPTZ,

  -- Lifecycle timestamps
  sent_at TIMESTAMPTZ,
  first_viewed_at TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,

  -- Email verification gate
  email_verified_at TIMESTAMPTZ,
  email_verification_code_hash TEXT,
  email_verification_attempts INTEGER NOT NULL DEFAULT 0,

  -- Signature evidence
  signed_at TIMESTAMPTZ,
  signed_typed_name TEXT,
  signed_ip TEXT,
  signed_user_agent TEXT,

  -- Final document
  signed_pdf_s3_key TEXT,
  signed_pdf_sha256 TEXT,

  -- Cancellation
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  void_reason TEXT,

  -- Optional appointment link
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,

  -- Reminders
  last_reminder_sent_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contract_envelopes_subaccount_status
  ON contract_envelopes(subaccount_id, status);

CREATE INDEX idx_contract_envelopes_contact
  ON contract_envelopes(contact_id);

CREATE INDEX idx_contract_envelopes_token
  ON contract_envelopes(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX idx_contract_envelopes_appointment
  ON contract_envelopes(appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX idx_contract_envelopes_expires
  ON contract_envelopes(expires_at)
  WHERE status IN ('sent', 'viewed');

-- ----------------------------------------------------------------------------
-- updated_at auto-update trigger function (reuse if it exists)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'trigger_set_updated_at'
  ) THEN
    CREATE FUNCTION trigger_set_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END$$;

CREATE TRIGGER contract_templates_updated_at
  BEFORE UPDATE ON contract_templates
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER contract_envelopes_updated_at
  BEFORE UPDATE ON contract_envelopes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification
-- ----------------------------------------------------------------------------
SELECT
  table_name,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = t.table_name AND table_schema='public') AS col_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('contract_templates', 'contract_envelopes')
ORDER BY table_name;
