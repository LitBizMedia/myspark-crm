CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  discount_type TEXT NOT NULL CHECK (discount_type IN ('pct','flat')),
  discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  applies_to TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','products')),
  product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_uses INTEGER,
  once_per_customer BOOLEAN NOT NULL DEFAULT FALSE,
  recurring_first_only BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_date TIMESTAMPTZ,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_sub_code
  ON coupons (subaccount_id, UPPER(code));
CREATE INDEX IF NOT EXISTS idx_coupons_sub_status
  ON coupons (subaccount_id, status);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  payment_id TEXT,
  amount_saved NUMERIC(10,2) NOT NULL DEFAULT 0,
  staff_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cpn_redeem_coupon
  ON coupon_redemptions (coupon_id);
CREATE INDEX IF NOT EXISTS idx_cpn_redeem_customer
  ON coupon_redemptions (coupon_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_cpn_redeem_sub
  ON coupon_redemptions (subaccount_id);
