-- Gift Cards migration: schema (Phase 1)
-- Applied 2026-06-05 via myspark-audit-db Lambda.
-- Three tables: gift_card_products (template), gift_cards (issued cards),
-- gift_card_log (audit trail, replaces the JSONB log array).

CREATE TABLE IF NOT EXISTS gift_card_products (
  id              TEXT PRIMARY KEY,
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  bg_color1       TEXT DEFAULT '#6b21ea',
  bg_color2       TEXT DEFAULT '#ff4000',
  bg_image_s3_key TEXT,
  denominations   JSONB NOT NULL DEFAULT '[]',
  custom_amount   BOOLEAN NOT NULL DEFAULT FALSE,
  terms           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gc_products_subaccount ON gift_card_products(subaccount_id);

CREATE TABLE IF NOT EXISTS gift_cards (
  id              TEXT PRIMARY KEY,
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  product_id      TEXT REFERENCES gift_card_products(id),
  contact_id      TEXT,
  recipient_name  TEXT,
  recipient_email TEXT,
  is_digital      BOOLEAN NOT NULL DEFAULT FALSE,
  original_amount NUMERIC(10,2) NOT NULL,
  balance         NUMERIC(10,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  issued_by_id    UUID,
  sold_via        TEXT,
  payment_id      TEXT,
  payment_method  TEXT,
  square_payment_id TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gift_cards_subaccount ON gift_cards(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(subaccount_id, code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_contact ON gift_cards(subaccount_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(subaccount_id, status);

CREATE TABLE IF NOT EXISTS gift_card_log (
  id              BIGSERIAL PRIMARY KEY,
  gift_card_id    TEXT NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  entry_type      TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  note            TEXT,
  contact_id      TEXT,
  payment_id      TEXT,
  staff_id        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gc_log_card ON gift_card_log(gift_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_log_subaccount ON gift_card_log(subaccount_id, created_at DESC);
