// api/subaccount/gift-cards-list.js (Lambda)
// GET|POST /api/subaccount/gift-cards-list
// Returns gift cards for the subaccount. Any authenticated subaccount user.
// Optional filters: status, contactId, page, pageSize (via query or body).

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const giftCards = require('./lib/gift-cards');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const q = (req.query || {});
  const body = (req.body || {});
  const opts = {
    status: q.status || body.status || null,
    contactId: q.contact_id || q.contactId || body.contactId || null,
    page: q.page || body.page || 1,
    pageSize: q.page_size || q.pageSize || body.pageSize || 200
  };

  try {
    const result = await giftCards.listBySubaccount(auth.subaccount_id, opts);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.gift_card.list',
      targetType: 'gift_card',
      targetSubaccountId: auth.subaccount_id,
      metadata: { total: result.total, returned: result.cards.length, status: opts.status || 'all' }
    });

    return res.status(200).json({ success: true, giftCards: result.cards, total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages });
  } catch (e) {
    console.error('gift-cards-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load gift cards' });
  }
}

exports.handler = wrap(handler);
