-- Single-use, server-side tokens for agency login-as flow.
-- Created May 13, 2026.
--
-- Replaces the previous localStorage-based token mechanism. The new flow:
--   1. Agency clicks "Login As" -> POST /api/agency/login-as
--      Server validates and creates a token row, returns the token in JSON
--   2. Frontend opens new tab without token in URL
--   3. New tab POSTs token to /api/agency/login-as-exchange
--      Server consumes token, mints a real subaccount session, sets cookie
--
-- Tokens are single-use, expire in 5 minutes, tied to a specific
-- agency user + target subaccount + target admin user.

CREATE TABLE IF NOT EXISTS agency_login_as_tokens (
  token            TEXT PRIMARY KEY,
  agency_user_id   TEXT NOT NULL,
  agency_username  TEXT NOT NULL,
  target_sub_id    TEXT NOT NULL,
  target_slug      TEXT NOT NULL,
  target_user_id   TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  ip_address       INET,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alat_expires ON agency_login_as_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_alat_target_sub ON agency_login_as_tokens (target_sub_id);
