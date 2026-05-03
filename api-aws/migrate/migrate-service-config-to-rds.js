// Migration: move serviceCategories and serviceWidgets out of subaccount_data blob.
//
// service_categories: new JSONB column on subaccount_data table. Already-loaded
//   path stays close (still on subaccount_data row), but it's a discrete column
//   that can be UPDATEd atomically without rewriting the whole blob.
//
// service_widgets: new dedicated table. Each widget is a row, full CRUD per
//   row. Future: indexable by id for public widget rendering.
//
// Migration steps:
//   1. ALTER TABLE subaccount_data ADD COLUMN service_categories JSONB
//   2. CREATE TABLE service_widgets
//   3. Backfill: copy data->'serviceCategories' to the new column
//   4. Backfill: copy each entry of data->'serviceWidgets' to a row
//   5. Verify counts
//
// Idempotent. Safe to re-run. ALTER and CREATE use IF NOT EXISTS. Backfill
// uses ON CONFLICT for service_widgets, and only updates service_categories
// for rows where it's still '[]' (the column default).

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

    // Step 1: column on subaccount_data
    await client.query(`
      ALTER TABLE subaccount_data
        ADD COLUMN IF NOT EXISTS service_categories JSONB DEFAULT '[]'::jsonb
    `);

    // Step 2: service_widgets table
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_widgets (
        id              TEXT PRIMARY KEY,
        subaccount_id   TEXT NOT NULL,
        name            TEXT NOT NULL,
        service_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
        primary_color   TEXT,
        logo_url        TEXT,
        tagline         TEXT,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Index on subaccount_id for the data-load query path
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_service_widgets_subaccount
        ON service_widgets(subaccount_id)
    `);

    // Step 3: backfill service_categories from blob
    // Only updates rows where the new column is still default '[]'
    // and the blob has a non-empty array.
    const catBackfill = await client.query(`
      UPDATE subaccount_data sd
        SET service_categories = COALESCE(data->'serviceCategories', '[]'::jsonb)
      WHERE service_categories = '[]'::jsonb
        AND jsonb_typeof(data->'serviceCategories') = 'array'
        AND jsonb_array_length(data->'serviceCategories') > 0
    `);

    // Step 4: backfill service_widgets from blob
    // For each subaccount_data row, expand data->'serviceWidgets' (an array
    // of widget objects) into rows. ON CONFLICT preserves any prior insert.
    const widgetBackfill = await client.query(`
      INSERT INTO service_widgets (
        id, subaccount_id, name, service_ids, primary_color, logo_url, tagline, active,
        created_at, updated_at
      )
      SELECT
        w->>'id',
        sd.subaccount_id,
        w->>'name',
        COALESCE(w->'service_ids', '[]'::jsonb),
        w->>'primary_color',
        w->>'logo_url',
        w->>'tagline',
        COALESCE((w->>'active')::boolean, TRUE),
        NOW(), NOW()
      FROM subaccount_data sd,
           jsonb_array_elements(COALESCE(sd.data->'serviceWidgets', '[]'::jsonb)) AS w
      WHERE jsonb_typeof(sd.data->'serviceWidgets') = 'array'
        AND w->>'id' IS NOT NULL
        AND w->>'name' IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `);

    // Verify counts
    const verify = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM subaccount_data WHERE service_categories != '[]'::jsonb) AS subs_with_categories,
        (SELECT COUNT(*) FROM service_widgets) AS total_widgets,
        (SELECT COUNT(DISTINCT subaccount_id) FROM service_widgets) AS subs_with_widgets
    `);

    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Migration complete',
        categories_backfilled: catBackfill.rowCount || 0,
        widgets_backfilled: widgetBackfill.rowCount || 0,
        verify: verify.rows[0]
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
