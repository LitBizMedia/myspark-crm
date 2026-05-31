-- EULA gate tables. Originally created via the myspark-audit-db Lambda on
-- 2026-05-31; recorded here so sql/ reflects the live schema.
--
-- eula_versions: one row per EULA version. Exactly one active at a time
-- (enforced by the partial unique index). Bumping the active version
-- re-prompts every user on next login.

CREATE TABLE IF NOT EXISTS eula_versions (
  id             TEXT PRIMARY KEY,
  version        TEXT NOT NULL UNIQUE,
  title          TEXT,
  body_html      TEXT NOT NULL,
  effective_date DATE,
  active         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eula_versions_one_active
  ON eula_versions (active) WHERE active = TRUE;

-- eula_acceptances: one row per (user, version) accepted. user_id FK cascades
-- so a deleted user takes their acceptances with them. Unique index makes
-- re-accept a no-op and lets the agency Unflag action clear by user.

CREATE TABLE IF NOT EXISTS eula_acceptances (
  id            TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES subaccount_users(id) ON DELETE CASCADE,
  eula_version  TEXT NOT NULL,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eula_acceptances_user_version
  ON eula_acceptances (user_id, eula_version);
