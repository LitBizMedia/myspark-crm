-- 2026-06-04: Add a CHECK constraint on payments.status.
--
-- The Payment Policy (MySpark-Payment-Policy.md) defines the allowed payment
-- statuses, but the DB never enforced them. A code bug could write any string
-- and the row would persist silently. This adds the guardrail so an invalid
-- status fails loudly at insert/update instead of corrupting payment data.
--
-- Allowed set matches the policy exactly:
--   completed | failed | voided | partial_refund | refunded
--
-- Verified before applying: all existing rows were status='completed' (13 rows),
-- no nulls, so the ALTER applied without reconciliation.

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('completed','failed','voided','partial_refund','refunded'));
