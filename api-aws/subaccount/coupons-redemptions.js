// api/subaccount/coupons-redemptions.js (Lambda)
// GET /api/subaccount/coupons-redemptions?id=cpn-xxx
// Returns the redemption history (usageLog shape) for one coupon, on demand.
// Read access for any authenticated non-practitioner. Powers the usage modal
// without loading every redemption on boot (blob migration 2026-06-03).

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const couponsLib = require('./lib/coupons');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role === 'practitioner') {
    return res.status(403).json({ error: 'Practitioners cannot access coupon data' });
  }

  const id = req.query && String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Coupon id is required' });

  try {
    const usageLog = await couponsLib.getCouponRedemptions(auth.subaccount_id, id);
    return res.status(200).json({ success: true, usageLog });
  } catch (e) {
    console.error('coupons-redemptions error:', e.message);
    return res.status(500).json({ error: 'Failed to load coupon usage' });
  }
}

exports.handler = wrap(handler);
