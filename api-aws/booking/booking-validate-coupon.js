// api/booking/validate-coupon.js
// POST /api/booking/validate-coupon
// PUBLIC - no auth required
// Validates a coupon code for a public booking widget. Returns the discount amount.
//
// This endpoint does NOT log usage (only booking-submit does, on successful charge).
// It only validates and returns the discount info so the patient sees it in the summary.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

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
    // Lookup subaccount
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ valid: false, error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // If widget_id provided, validate widget allows coupons (Stage 5 will check widget.allow_coupons; for now assume yes)
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

    // Read coupons from blob
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob = blobResult.rows[0]?.data || {};
    const couponList = blob.coupons || [];

    const coupon = couponList.find(c =>
      c && c.code && String(c.code).toUpperCase() === cleanCode && c.active !== false
    );

    if (!coupon) {
      return res.status(200).json({ valid: false, error: 'Coupon code is not valid' });
    }

    // Check expiration (compare to booking date if provided, else today)
    const checkDate = date || new Date().toISOString().slice(0, 10);
    if (coupon.expiresAt && coupon.expiresAt < checkDate) {
      return res.status(200).json({ valid: false, error: 'Coupon has expired' });
    }

    // Check usage limit
    if (coupon.usageLimit && (coupon.usageCount || 0) >= coupon.usageLimit) {
      return res.status(200).json({ valid: false, error: 'Coupon usage limit reached' });
    }

    // Compute discount
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
