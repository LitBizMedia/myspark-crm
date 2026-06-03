// api/subaccount/coupons-delete.js (Lambda)
// POST /api/subaccount/coupons-delete
// Body: { id }  Hard-deletes a coupon; redemptions cascade via FK.
// Admin/manager only (blob migration 2026-06-03).

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
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Coupon id is required' });

  try {
    // Confirm it exists + belongs to this subaccount before delete (clean 404 + audit truth).
    const existing = await couponsLib.getCouponById(auth.subaccount_id, id);
    if (!existing) return res.status(404).json({ error: 'Coupon not found' });

    await couponsLib.deleteCoupon(auth.subaccount_id, id);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.coupon.delete',
      targetType: 'coupon',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { code: existing.code }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('coupons-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete coupon' });
  }
}

exports.handler = wrap(handler);
