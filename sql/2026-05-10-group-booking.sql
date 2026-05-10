-- Group booking feature: schema additions
-- See docs/MySpark-Group-Booking-Spec.md

-- 1. Services columns for group config
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_capable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_staff_count INT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_eligible_staff JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_size_min INT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_size_max INT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_price NUMERIC(10,2);
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_resource_mode TEXT
  CHECK (group_resource_mode IN ('capacity', 'separate') OR group_resource_mode IS NULL);

-- 2. Multi-client junction table
CREATE TABLE IF NOT EXISTS appointment_clients (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_apptclients_appt ON appointment_clients(appointment_id);
CREATE INDEX IF NOT EXISTS idx_apptclients_contact ON appointment_clients(contact_id);

-- 3. Multi-staff junction table
CREATE TABLE IF NOT EXISTS appointment_staff (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_apptstaff_appt ON appointment_staff(appointment_id);
CREATE INDEX IF NOT EXISTS idx_apptstaff_staff ON appointment_staff(staff_id);
