-- Create form_submissions table for storing public form submissions
-- Contains PHI; retention 6 years per HIPAA
-- form_id is currently TEXT without FK because forms still live in the blob
-- TODO: add FK constraint when forms blob migration ships

CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL CHECK (LENGTH(form_id) > 0),
  form_name TEXT,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  contact_action TEXT CHECK (contact_action IN ('created', 'updated', 'matched', 'skipped', 'none', 'error') OR contact_action IS NULL),
  submission_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  page_url TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
  notification_email TEXT,
  notification_error TEXT,
  read_at TIMESTAMPTZ,
  read_by_user_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  archived_by_user_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  replied_at TIMESTAMPTZ,
  replied_by_user_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_data_size CHECK (pg_column_size(submission_data) < 100000)
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_form_active
  ON form_submissions(subaccount_id, form_id, created_at DESC)
  WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_form_submissions_subaccount_active
  ON form_submissions(subaccount_id, created_at DESC)
  WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_form_submissions_contact
  ON form_submissions(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_form_submissions_unread
  ON form_submissions(subaccount_id, created_at DESC)
  WHERE read_at IS NULL AND archived = FALSE;

COMMENT ON TABLE form_submissions IS 
  'Form submissions captured via public form endpoints. Contains PHI; access via subaccount-scoped Lambdas only. Retention: 6 years per HIPAA.';
COMMENT ON COLUMN form_submissions.ip_hash IS 
  'Truncated SHA-256 of submitter IP for spam analytics. Never store raw IP for GDPR alignment.';
COMMENT ON COLUMN form_submissions.schema_version IS 
  'Version of submission_data JSONB shape. Increment when shape changes; older rows can be migrated lazily.';
