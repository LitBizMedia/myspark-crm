const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');

const SQL = `
CREATE TABLE IF NOT EXISTS service_addons (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  duration_add INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_addons_subaccount ON service_addons(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_service_addons_service ON service_addons(service_id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]'::jsonb;
`;

exports.handler = async () => {
  const signer = new Signer({
    region: process.env.AWS_REGION,
    hostname: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT||'5432',10),
    username: process.env.RDS_USER
  });
  const token = await signer.getAuthToken();
  const pool = new Pool({
    host: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT||'5432',10),
    user: process.env.RDS_USER,
    password: token,
    database: process.env.RDS_DATABASE,
    ssl: { rejectUnauthorized: false }
  });
  try {
    await pool.query(SQL);
    const r1 = await pool.query("SELECT COUNT(*) FROM service_addons");
    const r2 = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='appointments' AND column_name='addons'");
    return { ok:true, service_addons_rows: r1.rows[0].count, addons_column_type: r2.rows[0]?.data_type };
  } catch(e) {
    return { ok:false, error: e.message };
  } finally {
    await pool.end();
  }
};
