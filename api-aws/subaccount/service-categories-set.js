// POST /api/subaccount/service-categories-set
// Replaces the full service_categories array on the subaccount_data row.
// Caller sends the entire list. Server validates and writes atomically.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  const categories = body.categories;
  if (!Array.isArray(categories)) {
    return res.status(400).json({ error: 'categories must be an array' });
  }

  // Coerce to strings, trim, drop empties, enforce 100 char cap, dedupe.
  const seen = new Set();
  const clean = [];
  for (const raw of categories) {
    const s = String(raw == null ? '' : raw).trim().slice(0, 100);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(s);
  }
  if (clean.length > 100) {
    return res.status(400).json({ error: 'too many categories (max 100)' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const result = await db.query(
      `UPDATE subaccount_data
         SET service_categories = $1::jsonb,
             updated_at = NOW()
       WHERE subaccount_id = $2`,
      [JSON.stringify(clean), subaccountId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'subaccount_data row not found' });
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.service_categories.set',
      targetType: 'subaccount_data', targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { count: clean.length }
    });

    return res.status(200).json({ success: true, categories: clean });
  } catch (e) {
    console.error('service-categories-set error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to save categories' });
  }
}

exports.handler = wrap(handler);
