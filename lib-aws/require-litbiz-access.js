// require-litbiz-access.js
// Wraps requireSubaccountAuth, adds LitBiz slug check.
// Returns auth context if LitBiz subaccount, else sends 403 and returns null.
//
// Usage (matches Express-style adapter pattern):
//   const { requireLitBizAccess } = require('./lib/require-litbiz-access');
//   const auth = await requireLitBizAccess(req, res);
//   if (!auth) return;

const { requireSubaccountAuth } = require('./require-subaccount-auth');
const db = require('./db');

const LITBIZ_SLUG = 'litbiz';

async function requireLitBizAccess(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return null;

  const result = await db.query(
    'SELECT slug FROM subaccounts WHERE id = $1 LIMIT 1',
    [auth.subaccount_id]
  );

  const slug = result.rows[0] && result.rows[0].slug;
  if (slug !== LITBIZ_SLUG) {
    res.status(403).json({ error: 'litbiz_only' });
    return null;
  }

  return auth;
}

module.exports = { requireLitBizAccess };
