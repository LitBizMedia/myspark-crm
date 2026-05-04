-- Add tax support columns
-- services.taxable: per-service taxable flag (defaults to true; user opts items out)
-- payments.tax_amount: tax collected on this payment
-- payments.taxable_amount: portion of subtotal that was taxable
-- All defaults preserve existing-row behavior.

BEGIN;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMIT;

-- Verify
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE (table_name = 'services' AND column_name = 'taxable')
   OR (table_name = 'payments' AND column_name IN ('tax_amount','taxable_amount'))
ORDER BY table_name, column_name;
