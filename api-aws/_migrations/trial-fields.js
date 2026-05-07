// One-time migration: add trial fields to subscription_plans and subscriptions.
// Idempotent. Safe to run multiple times.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  const log = [];

  try {
    log.push('=== subscription_plans.trial_days ===');
    await db.query(`
      ALTER TABLE subscription_plans
      ADD COLUMN IF NOT EXISTS trial_days INTEGER NOT NULL DEFAULT 0
        CHECK (trial_days >= 0 AND trial_days <= 365)
    `);
    log.push('  added trial_days column');

    log.push('=== subscriptions.trial_ends_at ===');
    await db.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS trial_ends_at DATE
    `);
    log.push('  added trial_ends_at column');

    log.push('=== subscriptions.trial_reminder_sent_at ===');
    await db.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS trial_reminder_sent_at TIMESTAMPTZ
    `);
    log.push('  added trial_reminder_sent_at column');

    log.push('=== subscriptions status check constraint ===');
    await db.query(`ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check`);
    await db.query(`
      ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_status_check
      CHECK (status IN ('active', 'trialing', 'paused', 'suspended', 'cancelled'))
    `);
    log.push('  status now allows trialing');

    log.push('=== verify ===');
    const colsRes = await db.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name IN ('subscription_plans', 'subscriptions')
        AND column_name IN ('trial_days', 'trial_ends_at', 'trial_reminder_sent_at')
      ORDER BY table_name, column_name
    `);
    for (const r of colsRes.rows) {
      log.push(`  ${r.column_name}: ${r.data_type} default=${r.column_default}`);
    }

    return res.status(200).json({ success: true, log });
  } catch (e) {
    log.push('ERROR: ' + e.message);
    return res.status(500).json({ success: false, log, error: e.message });
  }
}

exports.handler = wrap(handler);
