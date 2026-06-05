// api/subaccount/gift-cards-redeem.js (Lambda)
// POST /api/subaccount/gift-cards-redeem
// Deducts balance from a card (POS redemption). Admin/manager/user.
// Server-side guard: balance never goes negative, status set server-side,
// the deduct + log row are atomic (accessor lib, SELECT FOR UPDATE).
//
// Per Payment Policy: call this ONLY for completed payments. A failed charge
// must never reach this endpoint.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const giftCards = require('./lib/gift-cards');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  const giftCardId = String(body.giftCardId || body.id || '').trim();
  if (!giftCardId) return res.status(400).json({ error: 'Gift card id is required' });
  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Redeem amount must be greater than 0' });

  try {
    const out = await giftCards.deductBalance(auth.subaccount_id, {
      giftCardId,
      amount,
      note: body.note || 'Redeemed at POS',
      contactId: body.contactId || null,
      paymentId: body.paymentId || null,
      staffId: auth.user_id
    });

    if (!out.ok) {
      const map = {
        not_found: [404, 'Gift card not found'],
        bad_amount: [400, 'Redeem amount must be greater than 0'],
        insufficient_balance: [409, 'Gift card balance is too low for that amount'],
        card_voided: [409, 'This gift card has been voided'],
        card_refunded: [409, 'This gift card has been refunded']
      };
      const m = map[out.reason] || [400, 'Could not redeem gift card'];
      return res.status(m[0]).json({ error: m[1], reason: out.reason, balance: out.balance });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card.redeem',
      targetType: 'gift_card',
      targetId: giftCardId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { amount, new_balance: out.balance, new_status: out.status, payment_id: body.paymentId || null }
    });

    return res.status(200).json({ success: true, balance: out.balance, status: out.status });
  } catch (e) {
    console.error('gift-cards-redeem error:', e.message);
    return res.status(500).json({ error: 'Failed to redeem gift card' });
  }
}

exports.handler = wrap(handler);
