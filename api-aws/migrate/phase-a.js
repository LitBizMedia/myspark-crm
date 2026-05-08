// One-shot migration Lambda for Phase A schema additions.
// Uses IAM auth via @aws-sdk/rds-signer. The proxy is configured with
// IAMAuth=REQUIRED, so password auth alone is rejected.
//
// Required IAM:
//   rds-db:connect on dbuser:*/myspark_admin (already granted by myspark-lambda-rds-connect)
//
// Invoke with:
//   aws lambda invoke --function-name myspark-migrate-phase-a \
//     --region us-east-2 --payload '{}' --cli-binary-format raw-in-base64-out out.json
//   cat out.json

const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');

// Embedded migration SQL. Source: sql/2026-05-03-phase-a-schema.sql
const MIGRATION_SQL = `
ALTER TABLE services ADD COLUMN IF NOT EXISTS instructor_id UUID;
ALTER TABLE services ADD COLUMN IF NOT EXISTS capacity INT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS drop_in_allowed BOOLEAN DEFAULT TRUE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS recurrence_rule JSONB;
ALTER TABLE services ADD COLUMN IF NOT EXISTS last_generated_through DATE;

ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS series_id UUID;
ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS is_override BOOLEAN DEFAULT FALSE;
ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_id UUID;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_variation_id UUID;

CREATE INDEX IF NOT EXISTS idx_class_sessions_series_id
  ON class_sessions(series_id) WHERE series_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_service_id
  ON appointments(service_id) WHERE service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_services_recurrence_active
  ON services(subaccount_id) WHERE recurrence_rule IS NOT NULL AND active = TRUE;
`;

const VERIFY_QUERIES = [
  {
    label: 'services new columns',
    sql: `SELECT column_name FROM information_schema.columns
          WHERE table_name='services'
          AND column_name IN ('instructor_id','capacity','location','drop_in_allowed','recurrence_rule','last_generated_through')
          ORDER BY column_name`
  },
  {
    label: 'class_sessions new columns',
    sql: `SELECT column_name FROM information_schema.columns
          WHERE table_name='class_sessions'
          AND column_name IN ('series_id','is_override','price')
          ORDER BY column_name`
  },
  {
    label: 'appointments new columns',
    sql: `SELECT column_name FROM information_schema.columns
          WHERE table_name='appointments'
          AND column_name IN ('service_id','service_variation_id')
          ORDER BY column_name`
  }
];

// Generate an IAM auth token. Tokens last 15 minutes, plenty for this run.
async function getAuthToken(host, port, user, region) {
  const signer = new Signer({
    hostname: host,
    port: port,
    username: user,
    region: region
  });
  return await signer.getAuthToken();
}

exports.handler = async (event) => {
  const log = [];
  const push = (msg) => { console.log(msg); log.push(msg); };

  let pool;
  try {
    const host = process.env.RDS_PROXY_HOST;
    const port = parseInt(process.env.RDS_PORT) || 5432;
    const user = process.env.RDS_USER;
    const database = process.env.RDS_DATABASE;
    const region = process.env.AWS_REGION || 'us-east-2';

    push(`Generating IAM auth token for ${user}@${host}`);
    const token = await getAuthToken(host, port, user, region);
    push(`  Token generated (length: ${token.length})`);

    pool = new Pool({
      host,
      port,
      user,
      password: token,
      database,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 10000
    });

    push('Starting Phase A migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      push('  BEGIN');

      const statements = MIGRATION_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        const preview = stmt.split('\n')[0].slice(0, 80);
        push(`  Running: ${preview}...`);
        await client.query(stmt);
      }

      await client.query('COMMIT');
      push('  COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      push(`  ROLLBACK: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }

    push('');
    push('Verifying new columns exist:');

    const verifyResults = {};
    for (const v of VERIFY_QUERIES) {
      const result = await pool.query(v.sql);
      const cols = result.rows.map(r => r.column_name);
      verifyResults[v.label] = cols;
      push(`  ${v.label}: ${cols.join(', ')}`);
    }

    await pool.end();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Phase A migration applied successfully',
        log,
        verify: verifyResults
      }, null, 2)
    };
  } catch (e) {
    push(`ERROR: ${e.message}`);
    if (pool) { try { await pool.end(); } catch (_) {} }
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: e.message,
        log
      }, null, 2)
    };
  }
};
