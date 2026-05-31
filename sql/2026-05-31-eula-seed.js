// EULA seed — loads the EULA body HTML as the active version (v1.0).
//
// This is run THROUGH the myspark-audit-db Lambda, not standalone. The HTML
// file (2026-05-31-eula-v1.0-body.html) must be bundled into the Lambda zip
// alongside this script so it can be read from /var/task at runtime.
//
// To re-seed (e.g. fresh environment) or seed a NEW version:
//   1. Place the body HTML next to this script in the Lambda bundle.
//   2. Update the version string / effective_date below for a new version.
//   3. Bundle: index.js (this), eula_body.html, lib/db.js, node_modules.
//   4. Deploy to myspark-audit-db, invoke once.
// The one-active partial index guarantees only one active version at a time;
// inserting a new active version flips the prior one inactive, which re-prompts
// every user on their next login.
//
// Idempotent: refuses to double-insert the same version string.

const fs = require('fs');
const db = require('./lib/db');
const crypto = require('crypto');
exports.handler = async () => {
  const bodyHtml = fs.readFileSync('/var/task/eula_body.html', 'utf8');
  const existing = await db.query(`SELECT id, active FROM eula_versions WHERE version = $1`, ['1.0']);
  if (existing.rows.length) {
    return { skipped: true, reason: 'version 1.0 already exists', row: existing.rows[0] };
  }
  const id = 'eula-' + crypto.randomBytes(8).toString('hex');
  await db.query(`UPDATE eula_versions SET active = FALSE WHERE active = TRUE`);
  await db.query(
    `INSERT INTO eula_versions (id, version, title, body_html, effective_date, active, created_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, NOW())`,
    [id, '1.0', 'MySpark+ Terms of Service and End User License Agreement', bodyHtml, '2026-04-01']
  );
  const check = await db.query(
    `SELECT id, version, title, effective_date, active, length(body_html) AS html_len, created_at
     FROM eula_versions WHERE version = '1.0'`
  );
  return { seeded: true, row: check.rows[0] };
};
