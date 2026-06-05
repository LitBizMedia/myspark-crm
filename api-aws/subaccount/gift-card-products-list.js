// api/subaccount/gift-card-products-list.js (Lambda)
// GET|POST /api/subaccount/gift-card-products-list
// Returns gift card product templates. Any authenticated subaccount user.
// Resolves bgImage to a durable CloudFront URL from bg_image_s3_key here, so
// the frontend just reads product.bgImage like it always did. No key -> ''.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const products = require('./lib/gift-card-products');

// Booking-widget CloudFront distro (AES256 bucket, public via OAC). Gift card
// art lives at giftcard-art/<product-id>.<ext>. See Phase 4 migration.
const ART_CDN = 'https://dh460epvdorz0.cloudfront.net/';

function resolveImage(p) {
  if (p.bgImageS3Key) p.bgImage = ART_CDN + p.bgImageS3Key;
  else p.bgImage = '';
  return p;
}

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const list = (await products.getAllProducts(auth.subaccount_id)).map(resolveImage);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card_product.list',
      targetType: 'gift_card_product',
      targetSubaccountId: auth.subaccount_id,
      metadata: { count: list.length }
    });

    return res.status(200).json({ success: true, giftCardProducts: list });
  } catch (e) {
    console.error('gift-card-products-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load gift card products' });
  }
}

exports.handler = wrap(handler);
