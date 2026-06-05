// api/subaccount/gift-cards-issue.js (Lambda)
// POST /api/subaccount/gift-cards-issue
// Issues a new gift card (sale flow). Admin/manager only.
// Inserts the card and its 'issued' log entry atomically (accessor lib).

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const giftCards = require('./lib/gift-cards');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin' && auth.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can issue gift cards' });
  }

  const body = req.body || {};
  const original = parseFloat(body.originalAmount);
  if (isNaN(original) || original <= 0) {
    return res.status(400).json({ error: 'Gift card amount must be greater than 0' });
  }
  if (body.recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.recipientEmail))) {
    return res.status(400).json({ error: 'Recipient email is not valid' });
  }

  try {
    const card = await giftCards.createCard(auth.subaccount_id, {
      code: body.code,
      productId: body.productId || null,
      contactId: body.contactId || null,
      recipientName: body.recipientName || null,
      recipientEmail: body.recipientEmail || null,
      isDigital: !!body.isDigital,
      originalAmount: original,
      balance: body.balance != null ? parseFloat(body.balance) : original,
      issuedById: auth.user_id,
      soldVia: body.soldVia || 'gift-card-tab',
      paymentId: body.paymentId || null,
      paymentMethod: body.paymentMethod || null,
      squarePaymentId: body.squarePaymentId || null,
      note: body.note || null
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card.issue',
      targetType: 'gift_card',
      targetId: card.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { code: card.code, original_amount: card.originalAmount, sold_via: card.soldVia, payment_id: card.paymentId, is_digital: card.isDigital }
    });

    return res.status(200).json({ success: true, giftCard: card });
  } catch (e) {
    console.error('gift-cards-issue error:', e.message);
    return res.status(500).json({ error: 'Failed to issue gift card' });
  }
}

exports.handler = wrap(handler);
