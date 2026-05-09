-- Resources & Rooms feature: Stage 1 schema
-- See docs/MySpark-Resources-Spec.md

-- Resources: physical rooms or equipment that gate booking availability
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'room'
    CHECK (type IN ('room', 'equipment', 'other')),
  capacity INT NOT NULL DEFAULT 1,
  buffer_after INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_subaccount ON resources(subaccount_id);

-- Service-resource groups: a service can declare 0+ groups it needs
-- Each group has 1+ resources; only one resource per group must be free
CREATE TABLE IF NOT EXISTS service_resource_groups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_srg_service ON service_resource_groups(service_id);
CREATE INDEX IF NOT EXISTS idx_srg_subaccount ON service_resource_groups(subaccount_id);

-- Members of a resource group: which resources can satisfy this group
CREATE TABLE IF NOT EXISTS service_resource_group_members (
  group_id TEXT NOT NULL REFERENCES service_resource_groups(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, resource_id)
);

-- Appointment claims: which resources an appointment has claimed
CREATE TABLE IF NOT EXISTS appointment_resources (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  group_id TEXT,
  PRIMARY KEY (appointment_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_apptres_resource ON appointment_resources(resource_id);
