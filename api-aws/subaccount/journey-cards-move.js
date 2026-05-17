// POST /api/subaccount/journey-cards-move
//
// Move a card to a new stage and/or new position. Separate endpoint from
// upsert so we get a clean audit trail of moves and so position reflow
// is atomic with status flip.
//
// Behavior:
//   - If target stage stage_type = won: card.status becomes 'won', won_at = NOW(), lost_at cleared
//   - If target stage stage_type = lost: card.status becomes 'lost', lost_at = NOW(), won_at cleared
//   - If target stage stage_type = normal AND card.status != open: status becomes 'open', won_at/lost_at cleared
//   - Otherwise status unchanged
//   - Positions in source and target stages are renumbered 0..N-1 by current order

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isValidUid } = require('./lib/validators');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};

  if (!isValidUid(body.id)) {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!isValidUid(body.stage_id)) {
    return res.status(400).json({ error: 'stage_id is required' });
  }
  const newPosition = parseInt(body.position, 10);
  if (!Number.isFinite(newPosition) || newPosition < 0) {
    return res.status(400).json({ error: 'position must be a non-negative integer' });
  }

  try {
    const result = await db.transaction(async (client) => {
      // Lock the card row
      const cardRes = await client.query(
        `SELECT id, stage_id, journey_id, status
         FROM journey_cards
         WHERE id = $1 AND subaccount_id = $2 FOR UPDATE`,
        [body.id, subaccountId]
      );
      if (cardRes.rows.length === 0) throw new HttpError(404, 'Card not found');
      const card = cardRes.rows[0];

      // Verify target stage belongs to same journey + subaccount
      const stageRes = await client.query(
        `SELECT id, stage_type, journey_id
         FROM journey_stages
         WHERE id = $1 AND subaccount_id = $2`,
        [body.stage_id, subaccountId]
      );
      if (stageRes.rows.length === 0) throw new HttpError(404, 'Target stage not found');
      const newStage = stageRes.rows[0];
      if (newStage.journey_id !== card.journey_id) {
        throw new HttpError(400, 'Cannot move card across journeys');
      }

      const oldStageId = card.stage_id;
      const oldStatus = card.status;

      // Compute status change
      let newStatus = oldStatus;
      const setExtras = [];
      const extraParams = [];
      if (newStage.stage_type === 'won') {
        newStatus = 'won';
        setExtras.push('won_at = NOW()', 'lost_at = NULL');
      } else if (newStage.stage_type === 'lost') {
        newStatus = 'lost';
        setExtras.push('lost_at = NOW()', 'won_at = NULL');
      } else if (newStage.stage_type === 'normal' && oldStatus !== 'open') {
        newStatus = 'open';
        setExtras.push('won_at = NULL', 'lost_at = NULL');
      }

      // Step 1: Move the card to new stage with a temp high position
      // so we can renumber cleanly without unique-collision worries.
      const TEMP_POS = 999999;
      const setSql = ['stage_id = $1', 'position = $2', 'status = $3', 'updated_at = NOW()'].concat(setExtras).join(', ');
      await client.query(
        `UPDATE journey_cards SET ${setSql} WHERE id = $4 AND subaccount_id = $5`,
        [body.stage_id, TEMP_POS, newStatus, body.id, subaccountId]
      );

      // Step 2: Renumber the target stage. Get all active cards EXCEPT
      // the moved one (still at TEMP_POS) ordered by position, then
      // splice the moved card at newPosition.
      const targetCardsRes = await client.query(
        `SELECT id FROM journey_cards
         WHERE stage_id = $1 AND id != $2
         ORDER BY position ASC, updated_at ASC`,
        [body.stage_id, body.id]
      );
      const targetIds = targetCardsRes.rows.map(r => r.id);
      const insertAt = Math.max(0, Math.min(newPosition, targetIds.length));
      targetIds.splice(insertAt, 0, body.id);

      // Bulk renumber via single SQL using unnest
      if (targetIds.length > 0) {
        const idParams = targetIds;
        const posParams = targetIds.map((_, i) => i);
        await client.query(
          `UPDATE journey_cards AS jc
           SET position = data.pos, updated_at = NOW()
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS pos) AS data
           WHERE jc.id = data.id AND jc.subaccount_id = $3`,
          [idParams, posParams, subaccountId]
        );
      }

      // Step 3: Renumber the source stage if different
      if (oldStageId !== body.stage_id) {
        const oldRes = await client.query(
          `SELECT id FROM journey_cards
           WHERE stage_id = $1
           ORDER BY position ASC, updated_at ASC`,
          [oldStageId]
        );
        const oldIds = oldRes.rows.map(r => r.id);
        if (oldIds.length > 0) {
          const oldPos = oldIds.map((_, i) => i);
          await client.query(
            `UPDATE journey_cards AS jc
             SET position = data.pos, updated_at = NOW()
             FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS pos) AS data
             WHERE jc.id = data.id AND jc.subaccount_id = $3`,
            [oldIds, oldPos, subaccountId]
          );
        }
      }

      return {
        from_stage_id: oldStageId,
        to_stage_id: body.stage_id,
        from_status: oldStatus,
        to_status: newStatus,
        status_changed: oldStatus !== newStatus,
        final_position: insertAt
      };
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.journey_card.move',
      targetType: 'journey_card',
      targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: result
    });

    return res.status(200).json({ ok: true, id: body.id, ...result });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('journey-cards-move error:', err);
    return res.status(500).json({ error: 'Failed to move card', detail: err.message });
  }
}

exports.handler = wrap(handler);
