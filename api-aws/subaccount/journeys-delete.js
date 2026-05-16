// POST /api/subaccount/journeys-delete
//
// Hard delete a journey, cascading to stages and cards via FK ON DELETE CASCADE.
// Requires { confirm: true } in body since this destroys all cards in the journey.

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
  if (body.confirm !== true) {
    return res.status(400).json({ error: 'confirm: true is required to delete a journey' });
  }

  try {
    // Get journey + card count for audit log
    const journey = await db.findOne('journeys', { id: body.id, subaccount_id: subaccountId });
    if (!journey) {
      return res.status(404).json({ error: 'Journey not found' });
    }

    const cardCount = await db.count('journey_cards', { journey_id: body.id, subaccount_id: subaccountId });

    const deleted = await db.deleteWhere('journeys',
      { id: body.id, subaccount_id: subaccountId },
      { returning: 'id' }
    );
    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Journey not found' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.journey.delete',
      targetType: 'journey',
      targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: { name: journey.name, card_count: cardCount }
    });

    return res.status(200).json({ ok: true, id: body.id, cards_deleted: cardCount });
  } catch (err) {
    console.error('journeys-delete error:', err);
    return res.status(500).json({ error: 'Failed to delete journey', detail: err.message });
  }
}

exports.handler = wrap(handler);
