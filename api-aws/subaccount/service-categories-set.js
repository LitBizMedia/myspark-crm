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

  // Optional rename cascade: when renaming a category, also update services
  // that reference the old name.
  const renameFrom = (body.rename_from || '').trim();
  const renameTo = (body.rename_to || '').trim();
  const doCascade = renameFrom && renameTo && renameFrom !== renameTo;

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

    // Cascade rename: update any services with the old category name.
    // Note: not in a transaction with the categories update. If this fails
    // after the categories save, services will be left referencing the old
    // name. Rare and self-healing on next services save.
    let cascaded = 0;
    if (doCascade) {
      const cascadeResult = await db.query(
        `UPDATE services
           SET category = $1, updated_at = NOW()
         WHERE subaccount_id = $2 AND category = $3`,
        [renameTo, subaccountId, renameFrom]
      );
      cascaded = cascadeResult.rowCount || 0;
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: doCascade ? 'subaccount.service_categories.rename' : 'subaccount.service_categories.set',
      targetType: 'subaccount_data', targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { count: clean.length, rename_from: renameFrom || null, rename_to: renameTo || null, services_updated: cascaded }
    });

    return res.status(200).json({ success: true, categories: clean, services_updated: cascaded });
  } catch (e) {
    console.error('service-categories-set error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to save categories' });
  }
}

exports.handler = wrap(handler);
