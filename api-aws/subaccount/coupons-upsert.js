// api/subaccount/coupons-upsert.js (Lambda)
// POST /api/subaccount/coupons-upsert
// Creates or updates a coupon. Admin/manager only (matches canManageCoupons).
// Case-insensitive code uniqueness enforced by idx_coupons_sub_code; a duplicate
// returns a clean 409 (blob migration 2026-06-03).

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const couponsLib = require('./lib/coupons');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin' && auth.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can manage coupons' });
  }

  const body = req.body || {};
  const code = String(body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Coupon code is required' });
  if (code.length > 64) return res.status(400).json({ error: 'Coupon code is too long' });

  const dv = body.discountValue != null ? parseFloat(body.discountValue) : 0;
  if (isNaN(dv) || dv <= 0) {
    return res.status(400).json({ error: 'Discount value must be greater than 0' });
  }
  if (body.discountType === 'pct' && dv > 100) {
    return res.status(400).json({ error: 'Percentage discount cannot exceed 100' });
  }

  try {
    const isUpdate = !!(body.id && /^cpn-/.test(body.id));
    const coupon = await couponsLib.upsertCoupon(auth.subaccount_id, body);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isUpdate ? 'subaccount.coupon.update' : 'subaccount.coupon.create',
      targetType: 'coupon',
      targetId: coupon.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { code: coupon.code, discount_type: coupon.discountType, discount_value: coupon.discountValue, status: coupon.status }
    });

    return res.status(200).json({ success: true, coupon });
  } catch (e) {
    // Unique-violation on (subaccount_id, UPPER(code))
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'A coupon with this code already exists' });
    }
    console.error('coupons-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save coupon' });
  }
}

exports.handler = wrap(handler);
