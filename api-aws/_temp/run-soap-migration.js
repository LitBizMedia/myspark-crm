// api/_temp/run-soap-migration.js
// One-time migration Lambda. Deploys the soap_notes table.
// Delete this Lambda after running it once.
//
// Usage:
//   aws lambda invoke --function-name myspark-temp-soap-migration \
//     --region us-east-2 --no-cli-pager /tmp/out.json && cat /tmp/out.json

const db = require('./lib/db');

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS soap_notes (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  author_id TEXT,
  subjective TEXT NOT NULL DEFAULT '',
  objective  TEXT NOT NULL DEFAULT '',
  assessment TEXT NOT NULL DEFAULT '',
  plan       TEXT NOT NULL DEFAULT '',
  visit_date    DATE,
  template_used TEXT,
  signed_at  TIMESTAMPTZ,
  amendments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_soap_notes_contact     ON soap_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_soap_notes_subaccount  ON soap_notes(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_soap_notes_appointment ON soap_notes(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_soap_notes_author      ON soap_notes(author_id) WHERE author_id IS NOT NULL;
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

    // Verify
    const verify = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'soap_notes'
      ORDER BY ordinal_position
    `);
    result.columns = verify.rows;

    const idx = await db.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'soap_notes'
    `);
    result.indexes = idx.rows.map(r => r.indexname);

    return { statusCode: 200, body: JSON.stringify(result, null, 2) };
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }
};
