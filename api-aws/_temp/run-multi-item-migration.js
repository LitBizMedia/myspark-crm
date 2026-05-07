// api-aws/_temp/run-multi-item-migration.js
// Stage 3.5: subscriptions become multi-item containers with per-item discount.
//
// Changes:
//   1. Migrate existing items[] into the new structure: each item gets
//      price, planId, discountType, discountValue, discountNote,
//      discountRecurring, addedAt, billingEndsAt.
//   2. For subs that had sub-level manual discount, copy it onto the single
//      existing item (single-item is the only shape that exists today).
//   3. Drop sub-level coupon columns.
//   4. Drop sub-level manual discount columns.
//   5. Drop subscription_plans.notes (no longer used in UI).
//
// Idempotent: each step uses IF EXISTS guards.

const db = require('./lib/db');

const MIGRATION_SQL = `
-- ===========================================================================
-- 1. Restructure items JSONB: add price, planId, per-item discount fields.
--    Inherit price from sub.cycle_price and discount from sub.manual_discount_*.
--    Only runs on rows where items has at least one element.
-- ===========================================================================
UPDATE subscriptions
SET items = (
  SELECT jsonb_agg(
    item || jsonb_build_object(
      'price', cycle_price,
      'planId', plan_id,
      'discountType', manual_discount_type,
      'discountValue', manual_discount_value,
      'discountNote', COALESCE(manual_discount_note, ''),
      'discountRecurring', COALESCE(manual_discount_recurring, true),
      'addedAt', created_at,
      'billingEndsAt', NULL
    )
  )
  FROM jsonb_array_elements(items) AS item
),
updated_at = NOW()
WHERE jsonb_array_length(COALESCE(items, '[]'::jsonb)) > 0
  AND NOT (items @> '[{"price": null}]'::jsonb)  -- skip if already migrated
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) AS i
    WHERE i ? 'price'  -- skip if any item already has 'price' key
  );

-- ===========================================================================
-- 2. Drop coupon columns (subscriptions are now discount-only, no coupons)
-- ===========================================================================
ALTER TABLE subscriptions DROP COLUMN IF EXISTS coupon_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS coupon_code;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS coupon_recurring;

-- ===========================================================================
-- 3. Drop sub-level manual discount columns (now per-item)
-- ===========================================================================
ALTER TABLE subscriptions DROP COLUMN IF EXISTS manual_discount_type;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS manual_discount_value;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS manual_discount_note;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS manual_discount_recurring;

-- ===========================================================================
-- 4. Drop subscription_plans.notes (UI no longer surfaces it)
-- ===========================================================================
ALTER TABLE subscription_plans DROP COLUMN IF EXISTS notes;

-- ===========================================================================
-- 5. plan_id on subscriptions becomes nullable in concept (multi-plan subs
--    don't have a single plan_id). Already nullable per original schema, so
--    no DDL needed; new code just won't set plan_id at sub level.
-- ===========================================================================
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

    // Verify
    const verify = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='subscriptions' AND column_name='coupon_code') AS coupon_col_remaining,
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='subscriptions' AND column_name='manual_discount_type') AS sub_discount_col_remaining,
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name='subscription_plans' AND column_name='notes') AS plan_notes_col_remaining,
        (SELECT COUNT(*) FROM subscriptions WHERE jsonb_array_length(COALESCE(items, '[]'::jsonb)) > 0) AS subs_with_items
    `);
    result.verify = verify.rows[0];

    // Sanity: print the items shape of one sub so we can confirm
    const sample = await db.query(`SELECT id, items FROM subscriptions WHERE jsonb_array_length(COALESCE(items, '[]'::jsonb)) > 0 LIMIT 1`);
    if (sample.rows.length) {
      result.sample = { id: sample.rows[0].id, items: sample.rows[0].items };
    }

    return { statusCode: 200, body: JSON.stringify(result, null, 2) };
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }
};
