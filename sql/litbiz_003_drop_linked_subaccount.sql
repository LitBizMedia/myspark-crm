-- Stage 2 follow-up: drop linked_subaccount_id from SOP clients
-- The subaccount link feature was scoped out; no downstream consumer was built.
-- Column was always nullable, no data loss.

BEGIN;

ALTER TABLE litbiz_sop_clients DROP COLUMN IF EXISTS linked_subaccount_id;

COMMIT;
