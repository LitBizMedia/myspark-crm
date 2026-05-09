-- Stage 2 simplification: drop group tables, replace with simple service_resources join.
-- See docs/MySpark-Resources-Spec.md (updated)

DROP TABLE IF EXISTS service_resource_group_members CASCADE;
DROP TABLE IF EXISTS service_resource_groups CASCADE;

CREATE TABLE IF NOT EXISTS service_resources (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_sr_service ON service_resources(service_id);
CREATE INDEX IF NOT EXISTS idx_sr_resource ON service_resources(resource_id);
CREATE INDEX IF NOT EXISTS idx_sr_subaccount ON service_resources(subaccount_id);
