// GET /api/subaccount/journey-cards-list?journey_id=X
//
// Returns all cards for one journey (active + archived). Frontend filters
// by archived flag client-side based on the archive view toggle.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isValidUid } = require('./lib/validators');

function cardToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    journey_id: row.journey_id,
    stage_id: row.stage_id,
    title: row.title,
    contact_id: row.contact_id,
    appointment_id: row.appointment_id,
    assigned_staff_id: row.assigned_staff_id,
    lead_name: row.lead_name,
    lead_email: row.lead_email,
    lead_phone: row.lead_phone,
    value: row.value != null ? parseFloat(row.value) : 0,
    status: row.status,
    position: row.position,
    archived: !!row.archived,
    notes: row.notes,
    source: row.source,
    expected_close_date: row.expected_close_date instanceof Date ?
      (function(d){
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth()+1).padStart(2,'0');
        const da = String(d.getUTCDate()).padStart(2,'0');
        return y+'-'+m+'-'+da;
      })(row.expected_close_date) :
      row.expected_close_date,
    won_at: row.won_at instanceof Date ? row.won_at.toISOString() : row.won_at,
    lost_at: row.lost_at instanceof Date ? row.lost_at.toISOString() : row.lost_at,
    archived_at: row.archived_at instanceof Date ? row.archived_at.toISOString() : row.archived_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const journeyId = (req.query && req.query.journey_id) || null;

  if (!isValidUid(journeyId)) {
    return res.status(400).json({ error: 'journey_id query param is required' });
  }

  try {
    // Verify the journey belongs to this subaccount (tenant isolation)
    const journey = await db.findOne('journeys', { id: journeyId, subaccount_id: subaccountId });
    if (!journey) {
      return res.status(404).json({ error: 'Journey not found' });
    }

    const result = await db.query(
      `SELECT
         id, journey_id, stage_id, title,
         contact_id, appointment_id, assigned_staff_id,
         lead_name, lead_email, lead_phone,
         value, status, position, archived,
         notes, source, expected_close_date,
         won_at, lost_at, archived_at,
         created_at, updated_at
       FROM journey_cards
       WHERE journey_id = $1 AND subaccount_id = $2
       ORDER BY stage_id, position ASC`,
      [journeyId, subaccountId]
    );

    const cards = result.rows.map(cardToFrontend);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.journey_cards.bulk_list',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: { journey_id: journeyId, card_count: cards.length }
    });

    return res.status(200).json({ cards });
  } catch (err) {
    console.error('journey-cards-list error:', err);
    return res.status(500).json({ error: 'Failed to load cards', detail: err.message });
  }
}

exports.handler = wrap(handler);
