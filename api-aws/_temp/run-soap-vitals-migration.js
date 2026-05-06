// api/_temp/run-soap-vitals-migration.js
// Adds the `vitals` JSONB column to soap_notes for structured vital signs.
// Idempotent - safe to run multiple times.
//
// Usage:
//   aws lambda invoke --function-name myspark-temp-soap-vitals-migration \
//     --region us-east-2 --no-cli-pager /tmp/out.json && cat /tmp/out.json

const db = require('./lib/db');

const MIGRATION_SQL = `
ALTER TABLE soap_notes
  ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb;
`;

exports.handler = async function () {
  const result = { steps: [] };
  try {
    result.steps.push('Connecting to DB...');
    await db.query('SELECT 1');
    result.steps.push('Connected.');

    result.steps.push('Adding vitals column...');
    await db.query(MIGRATION_SQL);
    result.steps.push('Migration complete.');

    const verify = await db.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'soap_notes' AND column_name = 'vitals'
    `);
    result.column = verify.rows[0] || null;

    return { statusCode: 200, body: JSON.stringify(result, null, 2) };
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }
};
