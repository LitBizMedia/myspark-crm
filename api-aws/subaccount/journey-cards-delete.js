// POST /api/subaccount/journey-cards-delete
//
// Soft delete: sets archived = TRUE and archived_at = NOW().
// Card stays in DB and can be restored via journey-cards-upsert if needed
// (future). Hard delete is intentionally not exposed in Stage 1.
//
// Body: { id, restore? }
//   - restore: true unarchives a previously archived card

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
  const restore = body.restore === true;

  try {
    const card = await db.findOne('journey_cards', { id: body.id, subaccount_id: subaccountId });
    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const updated = await db.update(
      'journey_cards',
      {
        archived: !restore,
        archived_at: restore ? null : new Date(),
        updated_at: new Date()
      },
      { id: body.id, subaccount_id: subaccountId },
      { returning: 'id, archived, archived_at' }
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: restore ? 'subaccount.journey_card.restore' : 'subaccount.journey_card.archive',
      targetType: 'journey_card',
      targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: { title: card.title, value: card.value != null ? parseFloat(card.value) : 0 }
    });

    return res.status(200).json({ ok: true, id: body.id, archived: updated[0] && updated[0].archived });
  } catch (err) {
    console.error('journey-cards-delete error:', err);
    return res.status(500).json({ error: 'Failed to update card', detail: err.message });
  }
}

exports.handler = wrap(handler);
