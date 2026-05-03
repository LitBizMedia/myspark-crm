// Phase C.1 migration Lambda
// One-shot: adds buffer_before / buffer_after to appointments table.
// Pattern: VPC Lambda with IAM auth via rds-signer. Same as phase-a.js.
// Deploy, invoke once, verify, delete the function.

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
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS buffer_before INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS buffer_after  INT DEFAULT 0
    `);

    const verify = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'appointments'
        AND column_name IN ('buffer_before','buffer_after')
      ORDER BY column_name
    `);

    if (verify.rows.length !== 2) {
      throw new Error('Verification failed: expected 2 rows, got ' + verify.rows.length);
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Phase C.1 migration complete',
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
