-- The original applies_to CHECK only allowed ('all','products'), but the
-- frontend uses four channel values: all, pos, invoices, subscriptions.
-- 'products' was never a UI value (product scoping is the separate product_ids
-- column). Widen the constraint to the real set; default stays 'all'.
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_applies_to_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_applies_to_check
  CHECK (applies_to IN ('all', 'pos', 'invoices', 'subscriptions'));
