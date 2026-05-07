// api-aws/_temp/run-sub-plan-categories-migration.js
// Adds:
//   - subscription_plan_categories table (managed list per subaccount)
//   - subscription_plans.category_id (FK, nullable, ON DELETE SET NULL)
//   - subscription_plans.taxable (BOOLEAN, default TRUE)
// Idempotent.

const db = require('./lib/db');

const MIGRATION_SQL = `
-- ===========================================================================
-- subscription_plan_categories: managed list for sorting/filtering plans
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subscription_plan_categories (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  UNIQUE (subaccount_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sub_plan_cats_sub
  ON subscription_plan_categories(subaccount_id, sort_order);

-- ===========================================================================
-- subscription_plans: add category_id and taxable
-- ===========================================================================
-- ON DELETE SET NULL: deleting a category leaves plans uncategorized rather
-- than blocking the delete.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS category_id TEXT
  REFERENCES subscription_plan_categories(id) ON DELETE SET NULL;

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_subscription_plans_category
  ON subscription_plans(category_id) WHERE category_id IS NOT NULL;
`;

exports.handler = async function () {
  const result = { steps: [] };
  try {
    result.steps.push('Connecting...');
    await db.query('SELECT 1');
    result.steps.push('Connected.');

    result.steps.push('Running migration...');
    await db.query(MIGRATION_SQL);
    result.steps.push('Migration complete.');

    const verify = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name='subscription_plan_categories') AS cats_table,
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='subscription_plans' AND column_name='category_id') AS plan_cat_col,
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='subscription_plans' AND column_name='taxable') AS plan_tax_col
    `);
    result.verify = verify.rows[0];

    return { statusCode: 200, body: JSON.stringify(result, null, 2) };
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }
};
