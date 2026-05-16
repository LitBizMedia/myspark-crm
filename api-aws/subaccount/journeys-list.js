// GET /api/subaccount/journeys-list
//
// Returns all journeys for the authenticated subaccount, with their
// stages embedded and active card counts attached. Does NOT return cards;
// cards load per-journey via journey-cards-list when a journey is opened.
//
// Three queries run in parallel:
//   1. journeys for this subaccount
//   2. journey_stages for this subaccount (grouped client-side by journey_id)
//   3. journey_cards COUNT grouped by journey_id (active only, not archived)

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function journeyToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: !!row.active,
    color: row.color,
    sort_order: row.sort_order,
    stages: [],
    card_count: 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

function stageToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    journey_id: row.journey_id,
    name: row.name,
    stage_type: row.stage_type,
    color: row.color,
    sort_order: row.sort_order,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const [journeysResult, stagesResult, cardCountResult] = await Promise.all([
      db.query(
        `SELECT id, name, description, active, color, sort_order, created_at, updated_at
         FROM journeys
         WHERE subaccount_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [subaccountId]
      ),
      db.query(
        `SELECT id, journey_id, name, stage_type, color, sort_order, created_at, updated_at
         FROM journey_stages
         WHERE subaccount_id = $1
         ORDER BY journey_id, sort_order ASC`,
        [subaccountId]
      ),
      db.query(
        `SELECT journey_id, COUNT(*)::int AS cnt
         FROM journey_cards
         WHERE subaccount_id = $1
         GROUP BY journey_id`,
        [subaccountId]
      )
    ]);

    // Group stages by journey_id
    const stagesByJourney = {};
    stagesResult.rows.forEach(s => {
      if (!stagesByJourney[s.journey_id]) stagesByJourney[s.journey_id] = [];
      stagesByJourney[s.journey_id].push(stageToFrontend(s));
    });

    // Map active card counts by journey_id
    const cardCountByJourney = {};
    cardCountResult.rows.forEach(r => {
      cardCountByJourney[r.journey_id] = r.cnt;
    });

    const journeys = journeysResult.rows.map(row => {
      const j = journeyToFrontend(row);
      j.stages = stagesByJourney[row.id] || [];
      j.card_count = cardCountByJourney[row.id] || 0;
      return j;
    });

    const totalActiveCards = cardCountResult.rows.reduce((a, r) => a + r.cnt, 0);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.journeys.bulk_list',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        journey_count: journeys.length,
        stage_count: stagesResult.rows.length,
        active_card_count: totalActiveCards
      }
    });

    return res.status(200).json({ journeys });
  } catch (err) {
    console.error('journeys-list error:', err);
    return res.status(500).json({ error: 'Failed to load journeys', detail: err.message });
  }
}

exports.handler = wrap(handler);
