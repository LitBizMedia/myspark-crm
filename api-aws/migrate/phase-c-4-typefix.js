// Phase C.4 hotfix migration Lambda
// Phase A added several FK-style columns as UUID type. Service IDs in this
// codebase are uid()-format text strings (e.g., 'moqbivu6r2rsbg5pff'), not UUIDs.
// The mismatch surfaced when C.4 started bulk-inserting class_sessions with
// service_id/series_id sourced from a uid()-format service.
//
// This migration converts the affected columns to TEXT. Idempotent: each ALTER
// is wrapped in an IF EXISTS check on the current data_type, so re-running is safe.
//
// Columns converted:
//   class_sessions.id          UUID -> TEXT (defensive; allows non-UUID session IDs)
//   class_sessions.service_id  UUID -> TEXT (matches services.id format)
//   class_sessions.series_id   UUID -> TEXT (immediate blocker)
//   appointments.service_id    UUID -> TEXT (matches services.id format)
//   appointments.service_variation_id UUID -> TEXT (matches service_variations.id format)
//
// instructor_id columns stay UUID since user IDs are real UUIDs from subaccount_users.

const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');

exports.handler = async (event) => {
  const signer = new Signer({
    region: 'us-east-2',
    hostname: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT || '5432', 10),
    username: process.env.RDS_USER
  });
  const token = await signer.getAuthToken();

  const pool = new Pool({
    host: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT || '5432', 10),
    database: process.env.RDS_DATABASE,
    user: process.env.RDS_USER,
    password: token,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='class_sessions' AND column_name='id' AND data_type='uuid') THEN
          ALTER TABLE class_sessions ALTER COLUMN id TYPE TEXT USING id::TEXT;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='class_sessions' AND column_name='service_id' AND data_type='uuid') THEN
          ALTER TABLE class_sessions ALTER COLUMN service_id TYPE TEXT USING service_id::TEXT;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='class_sessions' AND column_name='series_id' AND data_type='uuid') THEN
          ALTER TABLE class_sessions ALTER COLUMN series_id TYPE TEXT USING series_id::TEXT;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='appointments' AND column_name='service_id' AND data_type='uuid') THEN
          ALTER TABLE appointments ALTER COLUMN service_id TYPE TEXT USING service_id::TEXT;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='appointments' AND column_name='service_variation_id' AND data_type='uuid') THEN
          ALTER TABLE appointments ALTER COLUMN service_variation_id TYPE TEXT USING service_variation_id::TEXT;
        END IF;
      END $$;
    `);

    const verify = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE (table_name='class_sessions' AND column_name IN ('id','service_id','series_id'))
         OR (table_name='appointments' AND column_name IN ('service_id','service_variation_id'))
      ORDER BY table_name, column_name
    `);

    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Phase C.4 type-fix migration complete',
        columns: verify.rows
      })
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message, stack: err.stack })
    };
  } finally {
    client.release();
    await pool.end();
  }
};
