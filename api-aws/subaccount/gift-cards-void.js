// api/subaccount/gift-cards-void.js (Lambda)
// POST /api/subaccount/gift-cards-void
// Voids a card: zeroes balance, status 'voided', logs a 'void' entry.
// Admin/manager only. Gift cards are never hard-deleted (money + audit trail);
// void preserves the row and history.

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { MANAGER_UP } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const giftCards = require('./lib/gift-cards');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: MANAGER_UP });
  if (!auth) return;


  const body = req.body || {};
  const giftCardId = String(body.giftCardId || body.id || '').trim();
  if (!giftCardId) return res.status(400).json({ error: 'Gift card id is required' });

  try {
    const out = await giftCards.voidCard(auth.subaccount_id, {
      giftCardId,
      note: body.note || 'Card voided',
      staffId: auth.user_id
    });

    if (!out.ok) {
      if (out.reason === 'not_found') return res.status(404).json({ error: 'Gift card not found' });
      return res.status(400).json({ error: 'Could not void gift card', reason: out.reason });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card.void',
      targetType: 'gift_card',
      targetId: giftCardId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { new_balance: out.balance, new_status: out.status }
    });

    return res.status(200).json({ success: true, balance: out.balance, status: out.status });
  } catch (e) {
    console.error('gift-cards-void error:', e.message);
    return res.status(500).json({ error: 'Failed to void gift card' });
  }
}

exports.handler = wrap(handler);
