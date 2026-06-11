// api/subaccount/coupons-list.js (Lambda)
// GET /api/subaccount/coupons-list
// Returns all coupons for the authenticated subaccount (camelCase shape).
// Read access for any authenticated subaccount user. Replaces blob hydration
// of db.coupons (blob migration 2026-06-03).

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const couponsLib = require('./lib/coupons');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Intentionally open to ANY authenticated role: User applies coupons at POS checkout.
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const coupons = await couponsLib.getAllCoupons(auth.subaccount_id);
    return res.status(200).json({ success: true, coupons });
  } catch (e) {
    console.error('coupons-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load coupons' });
  }
}

exports.handler = wrap(handler);
