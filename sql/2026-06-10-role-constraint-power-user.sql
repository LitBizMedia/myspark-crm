-- Update subaccount_users role CHECK constraint for the new role model.
-- Adds 'power_user', drops 'practitioner' (no rows held it after the
-- 2026-06-10 practitioner->user migration).
--
-- Applied live via myspark-audit-db on 2026-06-10. This file documents it
-- for migration history.
--
-- Roles: admin, manager, power_user, user.
-- super_admin is an agency session role, never stored on subaccount_users,
-- so it is intentionally NOT in this constraint.

ALTER TABLE subaccount_users DROP CONSTRAINT subaccount_users_role_check;

ALTER TABLE subaccount_users
  ADD CONSTRAINT subaccount_users_role_check
  CHECK (role = ANY (ARRAY['admin'::text,'manager'::text,'power_user'::text,'user'::text]));
