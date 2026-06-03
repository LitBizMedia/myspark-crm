// api/booking/validate-coupon.js
// POST /api/booking/validate-coupon
// PUBLIC - no auth required
// Validates a coupon code for a public booking widget. Returns the discount amount.
//
// CHANGED 2026-05-07: TZ-aware. Coupon expiry is checked against today in the
// subaccount's timezone, not UTC.
// CHANGED 2026-06-03: Reads coupons from the RDS coupons table via lib/coupons
// (blob migration). Fixes three drifted field checks that silently disabled
// enforcement: active (was c.active!==false, real field is status), expiry
// (was expiresAt, real field is expiryDate), max uses (was usageLimit, real
// field is maxUses).

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz } = require('./lib/timezone');
const couponsLib = require('./lib/coupons');

function r2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { slug, widget_id, coupon_code, subtotal, date } = body;

  if (!slug || !coupon_code) {
    return res.status(400).json({ valid: false, error: 'Missing slug or coupon code' });
  }
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
    return res.status(400).json({ valid: false, error: 'Invalid slug' });
  }
  const cleanCode = String(coupon_code).trim().toUpperCase();
  if (!cleanCode || cleanCode.length > 64) {
    return res.status(400).json({ valid: false, error: 'Invalid coupon code' });
  }

  try {
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ valid: false, error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    if (widget_id) {
      if (!/^[a-z0-9-]{1,64}$/i.test(widget_id)) {
        return res.status(400).json({ valid: false, error: 'Invalid widget id' });
      }
      const wRes = await db.query(
        `SELECT id FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = TRUE LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wRes.rows.length) {
        return res.status(404).json({ valid: false, error: 'Widget not found or inactive' });
      }
    }

    // Timezone still comes from the blob settings (TIER 3, stays in blob).
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob = blobResult.rows[0]?.data || {};
    const subTz = (blob.settings && blob.settings.timezone) || 'America/Chicago';

    // Coupons now read from the RDS table (camelCase shape via accessor).
    const coupon = await couponsLib.getCouponByCode(subaccountId, cleanCode);

    if (!coupon || coupon.status !== 'active') {
      return res.status(200).json({ valid: false, error: 'Coupon code is not valid' });
    }

    // Check expiration. Compare to either the booking date (passed in) or
    // today in the subaccount's timezone (NOT UTC; that's a 5-hour error in
    // Eastern that can falsely flag a still-valid coupon as expired).
    const checkDate = date || todayInTz(subTz);
    if (coupon.expiryDate && String(coupon.expiryDate).slice(0, 10) < checkDate) {
      return res.status(200).json({ valid: false, error: 'Coupon has expired' });
    }

    if (coupon.maxUses && (coupon.usageCount || 0) >= coupon.maxUses) {
      return res.status(200).json({ valid: false, error: 'Coupon usage limit reached' });
    }

    const subtotalNum = parseFloat(subtotal) || 0;
    if (subtotalNum <= 0) {
      return res.status(200).json({ valid: false, error: 'Coupon does not apply to free services' });
    }

    let discount = 0;
    if (coupon.discountType === 'pct') {
      discount = r2(subtotalNum * (parseFloat(coupon.discountValue || 0) / 100));
    } else {
      discount = r2(parseFloat(coupon.discountValue || 0));
    }
    discount = Math.min(discount, subtotalNum);

    if (discount <= 0) {
      return res.status(200).json({ valid: false, error: 'Coupon discount is zero' });
    }

    return res.status(200).json({
      valid: true,
      code: coupon.code,
      discount: discount,
      discount_type: coupon.discountType,
      discount_value: coupon.discountValue
    });
  } catch (e) {
    console.error('validate-coupon error:', e.message, e.stack);
    return res.status(500).json({ valid: false, error: 'Could not validate coupon. Please try again.' });
  }
}

exports.handler = wrap(handler);
