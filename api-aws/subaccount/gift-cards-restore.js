// api/subaccount/gift-cards-restore.js (Lambda)
// POST /api/subaccount/gift-cards-restore
// Restores balance to a card (refund of a prior redemption). Admin/manager.
// Capped at originalAmount server-side; status flips to 'active' when balance>0.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const giftCards = require('./lib/gift-cards');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role !== 'admin' && auth.role !== 'super_admin' && auth.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can refund gift cards' });
  }

  const body = req.body || {};
  const giftCardId = String(body.giftCardId || body.id || '').trim();
  if (!giftCardId) return res.status(400).json({ error: 'Gift card id is required' });
  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Restore amount must be greater than 0' });

  try {
    const out = await giftCards.restoreBalance(auth.subaccount_id, {
      giftCardId,
      amount,
      note: body.note || 'Refunded to gift card',
      contactId: body.contactId || null,
      paymentId: body.paymentId || null,
      staffId: auth.user_id
    });

    if (!out.ok) {
      const map = {
        not_found: [404, 'Gift card not found'],
        bad_amount: [400, 'Restore amount must be greater than 0'],
        card_voided: [409, 'This gift card has been voided']
      };
      const m = map[out.reason] || [400, 'Could not refund gift card'];
      return res.status(m[0]).json({ error: m[1], reason: out.reason });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card.restore',
      targetType: 'gift_card',
      targetId: giftCardId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { amount, new_balance: out.balance, new_status: out.status, payment_id: body.paymentId || null }
    });

    return res.status(200).json({ success: true, balance: out.balance, status: out.status });
  } catch (e) {
    console.error('gift-cards-restore error:', e.message);
    return res.status(500).json({ error: 'Failed to refund gift card' });
  }
}

exports.handler = wrap(handler);
