-- =====================================================
-- MySpark+ Plan Management - Phase A Migration
-- Run this in Supabase SQL Editor
-- =====================================================

-- 1. Plan and billing state per subaccount
CREATE TABLE IF NOT EXISTS subaccount_plans (
  subaccount_id TEXT PRIMARY KEY REFERENCES subaccounts(id) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter','professional','business','enterprise')),
  billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly','annual')),
  hipaa_addon BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','cancelled','exempt')),
  square_subscription_id TEXT,
  square_customer_id TEXT,
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  protected_from_deletion BOOLEAN DEFAULT FALSE,
  is_agency_workspace BOOLEAN DEFAULT FALSE,
  exempt_from_billing BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE subaccount_plans ENABLE ROW LEVEL SECURITY;

-- Allow anon role to read/write (matching pattern used by other tables in the project)
DROP POLICY IF EXISTS "anon_full_access_plans" ON subaccount_plans;
CREATE POLICY "anon_full_access_plans" ON subaccount_plans FOR ALL USING (true) WITH CHECK (true);

-- 2. Per-period usage counters (resets monthly)
CREATE TABLE IF NOT EXISTS subaccount_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  emails_sent INTEGER DEFAULT 0,
  sms_sent INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(subaccount_id, period_start)
);
ALTER TABLE subaccount_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_full_access_usage" ON subaccount_usage;
CREATE POLICY "anon_full_access_usage" ON subaccount_usage FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_usage_lookup ON subaccount_usage(subaccount_id, period_start, period_end);

-- 3. Permanent usage credits (rollover packs that never expire)
CREATE TABLE IF NOT EXISTS subaccount_credits (
  subaccount_id TEXT PRIMARY KEY REFERENCES subaccounts(id) ON DELETE CASCADE,
  email_credits INTEGER DEFAULT 0,
  sms_credits INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE subaccount_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_full_access_credits" ON subaccount_credits;
CREATE POLICY "anon_full_access_credits" ON subaccount_credits FOR ALL USING (true) WITH CHECK (true);

-- 4. Pack purchase history
CREATE TABLE IF NOT EXISTS usage_pack_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  pack_type TEXT NOT NULL CHECK (pack_type IN ('email_500','email_2000','email_10000','sms_100','sms_500','sms_2000')),
  units INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  square_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE usage_pack_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_full_access_packs" ON usage_pack_purchases;
CREATE POLICY "anon_full_access_packs" ON usage_pack_purchases FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_pack_purchases_subaccount ON usage_pack_purchases(subaccount_id, created_at DESC);

-- 5. Trigger to prevent deletion of protected subaccounts
CREATE OR REPLACE FUNCTION prevent_protected_subaccount_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM subaccount_plans
    WHERE subaccount_id = OLD.id AND protected_from_deletion = TRUE
  ) THEN
    RAISE EXCEPTION 'Cannot delete protected subaccount: %', OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_protected_deletion ON subaccounts;
CREATE TRIGGER trg_prevent_protected_deletion
BEFORE DELETE ON subaccounts
FOR EACH ROW
EXECUTE FUNCTION prevent_protected_subaccount_deletion();

-- 6. Seed LitBiz with exempt + protected status
INSERT INTO subaccount_plans (
  subaccount_id, plan_tier, billing_period, hipaa_addon, status,
  protected_from_deletion, is_agency_workspace, exempt_from_billing
) VALUES (
  'sub-litbiz', 'enterprise', 'monthly', FALSE, 'exempt',
  TRUE, TRUE, TRUE
)
ON CONFLICT (subaccount_id) DO UPDATE SET
  protected_from_deletion = TRUE,
  is_agency_workspace = TRUE,
  exempt_from_billing = TRUE,
  status = 'exempt',
  plan_tier = 'enterprise';

-- 7. For any existing subaccounts (e.g., wildflower) that don't have a plan record yet,
-- create a default starter plan in trialing state (14 days from now)
INSERT INTO subaccount_plans (subaccount_id, plan_tier, status, trial_ends_at)
SELECT
  s.id,
  'starter',
  'trialing',
  NOW() + INTERVAL '14 days'
FROM subaccounts s
WHERE NOT EXISTS (
  SELECT 1 FROM subaccount_plans p WHERE p.subaccount_id = s.id
);

-- Verification queries (run these to confirm setup):
-- SELECT * FROM subaccount_plans;
-- SELECT * FROM subaccount_usage;
-- SELECT * FROM subaccount_credits;
