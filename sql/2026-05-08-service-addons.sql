-- 2026-05-08: Service add-ons feature
-- Adds service_addons table and appointments.addons JSONB column

CREATE TABLE IF NOT EXISTS service_addons (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  duration_add INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_addons_subaccount ON service_addons(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_service_addons_service ON service_addons(service_id);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]'::jsonb;
