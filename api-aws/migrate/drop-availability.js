// Migration: drop dead `availability` column from services table.
// services-upsert no longer writes to it. The column has only ever held
// '{}' since the catalog redesign in C.3 stopped exposing the field.
// Sequencing: this Lambda runs AFTER the services-upsert Lambda update
// that stops writing to the column, otherwise active writes would crash.

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
      ALTER TABLE services DROP COLUMN IF EXISTS availability
    `);

    const verify = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'services' AND column_name = 'availability'
    `);

    if (verify.rows.length !== 0) {
      throw new Error('Verification failed: availability column still present');
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'availability column dropped from services'
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
