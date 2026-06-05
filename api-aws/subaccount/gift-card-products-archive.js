// api/subaccount/gift-card-products-archive.js (Lambda)
// POST /api/subaccount/gift-card-products-archive
// Archives a gift card product (soft). Admin/manager only.
// Products are not hard-deleted: issued cards reference product_id, and the
// product carries the card design. Archive hides it from new sales, keeps the FK.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const products = require('./lib/gift-card-products');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin' && auth.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can manage gift card products' });
  }

  const body = req.body || {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Product id is required' });

  try {
    const product = await products.archiveProduct(auth.subaccount_id, id);
    if (!product) return res.status(404).json({ error: 'Gift card product not found' });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card_product.archive',
      targetType: 'gift_card_product',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: product.name }
    });

    return res.status(200).json({ success: true, giftCardProduct: product });
  } catch (e) {
    console.error('gift-card-products-archive error:', e.message);
    return res.status(500).json({ error: 'Failed to archive gift card product' });
  }
}

exports.handler = wrap(handler);
