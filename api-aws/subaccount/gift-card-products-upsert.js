// api/subaccount/gift-card-products-upsert.js (Lambda)
// POST /api/subaccount/gift-card-products-upsert
// Creates or updates a gift card product template. Admin/manager only.
//
// Image handling: if the client sends bgImage as a data: URL (new upload),
// decode it, validate type/size, upload to the booking-widget bucket at
// giftcard-art/<product-id>.<ext>, and store the S3 key. If bgImage is already
// a CDN URL (unchanged on edit) or empty, leave the existing key as-is.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const products = require('./lib/gift-card-products');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ART_BUCKET = 'myspark-booking-widget';
const ART_PREFIX = 'giftcard-art/';
const ART_CDN = 'https://dh460epvdorz0.cloudfront.net/';
const MAX_IMG_BYTES = 2 * 1024 * 1024;
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

function genId() {
  return 'gcp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin' && auth.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can manage gift card products' });
  }

  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Product name is required' });

  const productId = (body.id && /^gcp-/.test(body.id)) ? body.id : genId();

  // Resolve the image. Only a fresh data: URL triggers an upload.
  let bgImageS3Key = body.bgImageS3Key || null;
  const img = String(body.bgImage || '');
  const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(img);
  if (m) {
    const mime = m[1].toLowerCase();
    const ext = /png/.test(mime) ? 'png' : 'jpg';
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_IMG_BYTES) {
      return res.status(400).json({ error: 'Image is too large (max 2MB)' });
    }
    const key = ART_PREFIX + productId + '.' + ext;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: ART_BUCKET,
        Key: key,
        Body: buf,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000, immutable'
      }));
      bgImageS3Key = key;
    } catch (e) {
      console.error('gift-card-products-upsert image upload failed:', e.name, e.message);
      return res.status(502).json({ error: 'Image upload failed' });
    }
  } else if (img && img.indexOf(ART_CDN) === 0) {
    // Unchanged existing CDN url: derive the key back from it.
    bgImageS3Key = img.slice(ART_CDN.length) || bgImageS3Key;
  }

  try {
    const isUpdate = !!(body.id && /^gcp-/.test(body.id));
    const product = await products.upsertProduct(auth.subaccount_id, {
      id: productId,
      name,
      status: ['active','inactive','archived'].includes(body.status) ? body.status : 'active',
      bgColor1: body.bgColor1,
      bgColor2: body.bgColor2,
      bgImageS3Key,
      denominations: Array.isArray(body.denominations) ? body.denominations : [],
      customAmount: !!body.customAmount,
      terms: body.terms
    });

    // Return bgImage resolved so the frontend can render immediately.
    product.bgImage = product.bgImageS3Key ? (ART_CDN + product.bgImageS3Key) : '';

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isUpdate ? 'subaccount.gift_card_product.update' : 'subaccount.gift_card_product.create',
      targetType: 'gift_card_product',
      targetId: product.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: product.name, status: product.status, has_image: !!product.bgImageS3Key }
    });

    return res.status(200).json({ success: true, giftCardProduct: product });
  } catch (e) {
    console.error('gift-card-products-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save gift card product' });
  }
}

exports.handler = wrap(handler);
