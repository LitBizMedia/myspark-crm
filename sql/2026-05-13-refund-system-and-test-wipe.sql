-- =============================================================
-- MySpark+ Migration: 2026-05-13
-- Purpose:
--   1. Create payment_refunds table for proper refund persistence
--   2. Wipe test payment/GC/pack/appointment/class-session data
--   3. Reset coupon usage stats (keep coupon definitions)
-- Keeps: payment pay-1778655638767-mybaua ($25 Melissa Kirby May 13)
--        all contacts, tasks, products, coupon definitions
--        all audit_log entries
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- STEP 1: Create payment_refunds table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_refunds (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  subaccount_id   TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  refunded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refunded_by     TEXT,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  gift_card_portion  NUMERIC(10,2) NOT NULL DEFAULT 0,
  card_portion       NUMERIC(10,2) NOT NULL DEFAULT 0,
  reason          TEXT,
  square_refunded BOOLEAN NOT NULL DEFAULT FALSE,
  square_refund_id TEXT,
  gc_restored     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment_id   ON payment_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_subaccount   ON payment_refunds(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_refunded_at  ON payment_refunds(refunded_at DESC);

-- -------------------------------------------------------------
-- STEP 2: Wipe test data
-- -------------------------------------------------------------

-- Verify the payment we want to keep exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payments WHERE id = 'pay-1778655638767-mybaua') THEN
    RAISE EXCEPTION 'ABORT: payment to preserve (pay-1778655638767-mybaua) not found';
  END IF;
END $$;

-- Test payments (keep only the May 13 $25 Melissa Kirby payment)
DELETE FROM payments
WHERE subaccount_id = 'sub-litbiz'
  AND id != 'pay-1778655638767-mybaua';

-- Today's 2 test appointments (CASCADE handles appointment_clients/staff/resources)
DELETE FROM appointments
WHERE subaccount_id = 'sub-litbiz';

-- All 30 test class sessions
DELETE FROM class_sessions
WHERE subaccount_id = 'sub-litbiz';

-- Empty giftCards, sessionPacks arrays in blob;
-- reset coupon usageCount and usageLog while preserving coupon definitions
UPDATE subaccount_data
SET data = jsonb_set(
  jsonb_set(
    jsonb_set(
      data,
      '{giftCards}',
      '[]'::jsonb
    ),
    '{sessionPacks}',
    '[]'::jsonb
  ),
  '{coupons}',
  (
    SELECT COALESCE(jsonb_agg(
      coupon - 'usageLog'                              -- drop usageLog
        || jsonb_build_object('usageCount', 0)         -- reset counter
        || jsonb_build_object('usageLog', '[]'::jsonb) -- empty log array
    ), '[]'::jsonb)
    FROM jsonb_array_elements(COALESCE(data->'coupons','[]'::jsonb)) AS coupon
  )
)
WHERE subaccount_id = 'sub-litbiz';

-- -------------------------------------------------------------
-- STEP 3: Verification
-- -------------------------------------------------------------
DO $$
DECLARE
  pmt_count INT;
  appt_count INT;
  cs_count INT;
  gc_count INT;
  pack_count INT;
  coupon_usage INT;
BEGIN
  SELECT COUNT(*) INTO pmt_count FROM payments WHERE subaccount_id = 'sub-litbiz';
  SELECT COUNT(*) INTO appt_count FROM appointments WHERE subaccount_id = 'sub-litbiz';
  SELECT COUNT(*) INTO cs_count FROM class_sessions WHERE subaccount_id = 'sub-litbiz';
  SELECT jsonb_array_length(COALESCE(data->'giftCards','[]'::jsonb))      INTO gc_count
    FROM subaccount_data WHERE subaccount_id = 'sub-litbiz';
  SELECT jsonb_array_length(COALESCE(data->'sessionPacks','[]'::jsonb))   INTO pack_count
    FROM subaccount_data WHERE subaccount_id = 'sub-litbiz';
  SELECT COALESCE(SUM((coupon->>'usageCount')::int), 0) INTO coupon_usage
    FROM subaccount_data,
         jsonb_array_elements(COALESCE(data->'coupons','[]'::jsonb)) AS coupon
    WHERE subaccount_id = 'sub-litbiz';

  RAISE NOTICE 'Post-wipe counts: payments=%, appointments=%, class_sessions=%, gift_cards=%, session_packs=%, coupon_usage_total=%',
    pmt_count, appt_count, cs_count, gc_count, pack_count, coupon_usage;

  IF pmt_count != 1 THEN RAISE EXCEPTION 'ABORT: expected 1 payment, got %', pmt_count; END IF;
  IF appt_count != 0 THEN RAISE EXCEPTION 'ABORT: expected 0 appointments, got %', appt_count; END IF;
  IF cs_count != 0 THEN RAISE EXCEPTION 'ABORT: expected 0 class_sessions, got %', cs_count; END IF;
  IF gc_count != 0 THEN RAISE EXCEPTION 'ABORT: expected 0 gift cards, got %', gc_count; END IF;
  IF pack_count != 0 THEN RAISE EXCEPTION 'ABORT: expected 0 session packs, got %', pack_count; END IF;
  IF coupon_usage != 0 THEN RAISE EXCEPTION 'ABORT: expected coupon usage 0, got %', coupon_usage; END IF;
END $$;

COMMIT;

