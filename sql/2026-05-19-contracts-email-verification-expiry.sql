-- Add expiry column for email verification codes
-- See docs/MySpark-Contracts-Spec.md Stage 4
ALTER TABLE contract_envelopes
ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;
