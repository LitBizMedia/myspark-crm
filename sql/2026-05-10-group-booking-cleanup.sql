-- Drop unused group booking columns.
-- group_eligible_staff: replaced by existing assigned_staff column
-- group_resource_mode: now auto-detected by the resource resolver

ALTER TABLE services DROP COLUMN IF EXISTS group_eligible_staff;
ALTER TABLE services DROP COLUMN IF EXISTS group_price;
ALTER TABLE services DROP COLUMN IF EXISTS group_resource_mode;
