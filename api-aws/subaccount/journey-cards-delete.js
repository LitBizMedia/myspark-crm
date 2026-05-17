// POST /api/subaccount/journey-cards-delete
//
// Hard delete a card row. Position reflow happens on next list load
// (positions are integers but the renderer sorts and the next move
// renumbers if needed). For Stage 1 we accept that deleting from the
// middle of a stage may leave a position gap until the next move; this
// is harmless because rendering sorts by position and gaps are inert.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isValidUid } = require('./lib/validators');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};

  if (!isValidUid(body.id)) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const card = await db.findOne('journey_cards', { id: body.id, subaccount_id: subaccountId });
    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const deleted = await db.deleteWhere(
      'journey_cards',
      { id: body.id, subaccount_id: subaccountId },
      { returning: 'id' }
    );
    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.journey_card.delete',
      targetType: 'journey_card',
      targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: {
        title: card.title,
        value: card.value != null ? parseFloat(card.value) : 0,
        stage_id: card.stage_id,
        journey_id: card.journey_id
      }
    });

    return res.status(200).json({ ok: true, id: body.id });
  } catch (err) {
    console.error('journey-cards-delete error:', err);
    return res.status(500).json({ error: 'Failed to delete card', detail: err.message });
  }
}

exports.handler = wrap(handler);
