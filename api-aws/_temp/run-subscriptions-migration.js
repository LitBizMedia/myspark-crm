// api-aws/_temp/run-subscriptions-migration.js
// Creates the subscription system tables: plans, subscriptions, events.
// Also adds subscription_id column to payments for cross-linking.
// Idempotent - safe to run multiple times.
//
// Schema rationale:
// - subscription_plans: the catalog. Items + per-cycle pricing.
// - subscriptions: contracts tying contacts to plans (or custom items).
//   Plan name, cycle price, and items are SNAPSHOTTED at creation so
//   later plan changes don't affect existing subscribers.
// - subscription_events: append-only audit log for the History tab.
// - payments.subscription_id: cross-link from each charged cycle.
//
// Status model:
//   active    - charging on schedule
//   paused    - admin-initiated, manual resume only
//   suspended - system-initiated after failed charges, auto-resumes on success
//   cancelled - terminal, no resume

const db = require('./lib/db');

const MIGRATION_SQL = `
-- ===========================================================================
-- subscription_plans: the catalog
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- items: array of { id, name, description, taxable }
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- pricing: { weekly:{enabled,price}, monthly:{...}, quarterly:{...}, annual:{...} }
  pricing JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_subaccount
  ON subscription_plans(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_active
  ON subscription_plans(subaccount_id, active) WHERE active = TRUE;

-- ===========================================================================
-- subscriptions: the contracts
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,

  -- plan_id is nullable for custom mode (no catalog plan)
  -- ON DELETE RESTRICT prevents plan deletion while subscribers exist
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_name_snapshot TEXT NOT NULL,

  -- Cycle and price snapshotted at creation; immune to later plan edits
  billing_cycle TEXT NOT NULL
    CHECK (billing_cycle IN ('weekly','monthly','quarterly','annual')),
  cycle_price NUMERIC(10,2) NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Lifecycle status
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','suspended','cancelled')),
  start_date DATE NOT NULL,
  next_due_date DATE NOT NULL,
  last_charged_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Payment method (Square card on file)
  card_id TEXT,

  -- Coupon (one per sub). coupon_recurring=FALSE means first cycle only.
  coupon_id TEXT,
  coupon_code TEXT,
  coupon_recurring BOOLEAN NOT NULL DEFAULT FALSE,

  -- Manual discount (one per sub). manual_discount_recurring=TRUE means every cycle.
  manual_discount_type TEXT
    CHECK (manual_discount_type IS NULL OR manual_discount_type IN ('flat','pct')),
  manual_discount_value NUMERIC(10,2),
  manual_discount_note TEXT,
  manual_discount_recurring BOOLEAN NOT NULL DEFAULT TRUE,

  -- Owner (staff member assigned). Nullable; defaults to no owner.
  owner_user_id TEXT,

  -- Failure tracking for suspension logic (3 attempts over 7 days -> suspended)
  failed_charge_count INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  last_failure_reason TEXT,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subaccount
  ON subscriptions(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_contact
  ON subscriptions(contact_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions(subaccount_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due
  ON subscriptions(next_due_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan
  ON subscriptions(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_owner
  ON subscriptions(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- ===========================================================================
-- subscription_events: append-only audit log for History tab
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subscription_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL
    REFERENCES subscriptions(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,

  -- event_type kept as TEXT (no enum) so new types can be added without migrations.
  -- Known types: created, edited, paused, resumed, cancelled, charge_succeeded,
  -- charge_failed, charge_retried, auto_suspended, resumed_from_suspension,
  -- coupon_applied, coupon_removed, item_changed, owner_changed,
  -- card_changed, discount_applied, discount_removed
  event_type TEXT NOT NULL,

  actor_user_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','system','cron')),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Cross-link to the payment record this event produced (charge events)
  payment_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_subscription
  ON subscription_events(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_events_type
  ON subscription_events(subaccount_id, event_type);

-- ===========================================================================
-- payments: add subscription_id column for cross-linking each charged cycle
-- ===========================================================================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS subscription_id TEXT;
CREATE INDEX IF NOT EXISTS idx_payments_subscription
  ON payments(subscription_id) WHERE subscription_id IS NOT NULL;
`;

exports.handler = async function () {
  const result = { steps: [] };
  try {
    result.steps.push('Connecting to DB...');
    await db.query('SELECT 1');
    result.steps.push('Connected.');

    result.steps.push('Running migration...');
    await db.query(MIGRATION_SQL);
    result.steps.push('Migration complete.');

    // Verify all 3 tables and the new payments column
    const verify = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name='subscription_plans') AS plans_table,
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name='subscriptions') AS subs_table,
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name='subscription_events') AS events_table,
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='payments' AND column_name='subscription_id') AS payments_col
    `);
    result.verify = verify.rows[0];

    // Show indexes for sanity
    const idx = await db.query(`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname='public'
        AND tablename IN ('subscription_plans','subscriptions','subscription_events')
      ORDER BY tablename, indexname
    `);
    result.indexes = idx.rows;

    return { statusCode: 200, body: JSON.stringify(result, null, 2) };
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }
};
