-- Restore the groups-based schema. Drop the flat service_resources table.
-- Final design: boxes (groups) of OR'd resources, joined by AND across boxes.

DROP TABLE IF EXISTS service_resources CASCADE;

CREATE TABLE IF NOT EXISTS service_resource_groups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_srg_service ON service_resource_groups(service_id);
CREATE INDEX IF NOT EXISTS idx_srg_subaccount ON service_resource_groups(subaccount_id);

CREATE TABLE IF NOT EXISTS service_resource_group_members (
  group_id TEXT NOT NULL REFERENCES service_resource_groups(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, resource_id)
);
