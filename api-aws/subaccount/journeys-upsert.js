// POST /api/subaccount/journeys-upsert
//
// Create or update a journey AND its stages in one atomic call.
// Stages array fully replaces existing stages:
//   - matched by id  -> updated
//   - missing id     -> created
//   - existing id not in payload -> deleted (only if no cards in that stage)
//
// On create of a NEW journey (no body.id), if stages is omitted/empty,
// the Lambda auto-creates default Won + Lost stages.
//
// Validation:
//   - At least one won stage and one lost stage must remain after the upsert
//   - Stage names must be unique within a journey
//   - Stage deletion requires zero active cards in that stage

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isValidUid, isNonEmptyString } = require('./lib/validators');

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

function defaultStages(journeyId, subaccountId) {
  return [
    { id: 'stg_' + uid(), journey_id: journeyId, subaccount_id: subaccountId, name: 'Won',  stage_type: 'won',  color: '#34d399', sort_order: 100 },
    { id: 'stg_' + uid(), journey_id: journeyId, subaccount_id: subaccountId, name: 'Lost', stage_type: 'lost', color: '#f87171', sort_order: 101 }
  ];
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};

  // Pre-transaction validation
  if (!isNonEmptyString(body.name, 200)) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (body.id && !isValidUid(body.id)) {
    return res.status(400).json({ error: 'invalid journey id' });
  }
  if (body.stages && !Array.isArray(body.stages)) {
    return res.status(400).json({ error: 'stages must be an array' });
  }
  if (body.stages) {
    const seenNames = new Set();
    for (const s of body.stages) {
      if (!isNonEmptyString(s.name, 100)) {
        return res.status(400).json({ error: 'stage name required' });
      }
      const nameLower = s.name.toLowerCase().trim();
      if (seenNames.has(nameLower)) {
        return res.status(400).json({ error: 'duplicate stage name: ' + s.name });
      }
      seenNames.add(nameLower);
      if (s.stage_type && ['normal','won','lost'].indexOf(s.stage_type) < 0) {
        return res.status(400).json({ error: 'invalid stage_type: ' + s.stage_type });
      }
      if (s.id && !isValidUid(s.id)) {
        return res.status(400).json({ error: 'invalid stage id' });
      }
    }
  }

  const isCreate = !body.id;
  const journeyId = body.id || ('jrn_' + uid());

  try {
    const result = await db.transaction(async (client) => {
      if (!isCreate) {
        const found = await client.query(
          `SELECT id FROM journeys WHERE id = $1 AND subaccount_id = $2 FOR UPDATE`,
          [journeyId, subaccountId]
        );
        if (found.rows.length === 0) throw new HttpError(404, 'Journey not found');
      }

      if (isCreate) {
        await client.query(
          `INSERT INTO journeys (id, subaccount_id, name, description, active, color, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [journeyId, subaccountId, body.name, body.description || null,
           body.active !== false, body.color || '#6b21ea', body.sort_order || 0]
        );
      } else {
        await client.query(
          `UPDATE journeys
           SET name = $1, description = $2, active = $3, color = $4, sort_order = $5, updated_at = NOW()
           WHERE id = $6 AND subaccount_id = $7`,
          [body.name, body.description || null, body.active !== false,
           body.color || '#6b21ea', body.sort_order || 0, journeyId, subaccountId]
        );
      }

      let stagesPayload = body.stages;
      if (isCreate && (!stagesPayload || stagesPayload.length === 0)) {
        stagesPayload = defaultStages(journeyId, subaccountId);
      }

      if (stagesPayload && stagesPayload.length > 0) {
        const existing = await client.query(
          `SELECT id FROM journey_stages WHERE journey_id = $1 AND subaccount_id = $2`,
          [journeyId, subaccountId]
        );
        const existingIds = new Set(existing.rows.map(r => r.id));
        const payloadIds = new Set(stagesPayload.filter(s => s.id).map(s => s.id));
        const toDelete = [...existingIds].filter(id => !payloadIds.has(id));

        if (toDelete.length > 0) {
          const cardCheck = await client.query(
            `SELECT stage_id, COUNT(*)::int AS cnt
             FROM journey_cards
             WHERE stage_id = ANY($1::text[])
             GROUP BY stage_id`,
            [toDelete]
          );
          if (cardCheck.rows.length > 0) {
            throw new HttpError(409, 'Cannot delete stages that contain cards', { stages_with_cards: cardCheck.rows });
          }
          await client.query(
            `DELETE FROM journey_stages WHERE id = ANY($1::text[]) AND subaccount_id = $2`,
            [toDelete, subaccountId]
          );
        }

        for (const s of stagesPayload) {
          const sId = s.id || ('stg_' + uid());
          if (s.id && existingIds.has(s.id)) {
            await client.query(
              `UPDATE journey_stages
               SET name = $1, stage_type = $2, color = $3, sort_order = $4, updated_at = NOW()
               WHERE id = $5 AND subaccount_id = $6`,
              [s.name, s.stage_type || 'normal', s.color || '#6b21ea', s.sort_order || 0, sId, subaccountId]
            );
          } else {
            await client.query(
              `INSERT INTO journey_stages (id, journey_id, subaccount_id, name, stage_type, color, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [sId, journeyId, subaccountId, s.name, s.stage_type || 'normal', s.color || '#6b21ea', s.sort_order || 0]
            );
          }
        }

        const typeCheck = await client.query(
          `SELECT stage_type, COUNT(*)::int AS cnt
           FROM journey_stages
           WHERE journey_id = $1 AND subaccount_id = $2
           GROUP BY stage_type`,
          [journeyId, subaccountId]
        );
        const typeCounts = {};
        typeCheck.rows.forEach(r => { typeCounts[r.stage_type] = r.cnt; });
        if (!typeCounts.won || typeCounts.won < 1) {
          throw new HttpError(400, 'Journey must have at least one Won stage');
        }
        if (!typeCounts.lost || typeCounts.lost < 1) {
          throw new HttpError(400, 'Journey must have at least one Lost stage');
        }
      }

      return { stage_count: stagesPayload ? stagesPayload.length : 0 };
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isCreate ? 'subaccount.journey.create' : 'subaccount.journey.update',
      targetType: 'journey',
      targetId: journeyId,
      targetSubaccountId: subaccountId,
      metadata: { name: body.name, stage_count: result.stage_count }
    });

    return res.status(200).json({ ok: true, id: journeyId });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json(Object.assign({ error: err.message }, err.extra));
    }
    console.error('journeys-upsert error:', err);
    return res.status(500).json({ error: 'Failed to save journey', detail: err.message });
  }
}

exports.handler = wrap(handler);
