// POST /api/subaccount/journey-cards-upsert
//
// Create or update a card. Does NOT change stage_id on existing cards;
// use journey-cards-move for stage changes (clean audit trail, atomic
// position reflow, status flip handling).
//
// Validation:
//   - title required
//   - journey_id + stage_id required on create, must belong to subaccount
//   - contact_id, appointment_id, assigned_staff_id (if set) must belong to subaccount
//   - assigned_staff_id must be a valid UUID format (UUID column, validate at edge)
//   - value must be a non-negative number

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { isValidUid, isValidUuid, isNonEmptyString, coerceMoney } = require('./lib/validators');

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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

  // Validation
  if (!isNonEmptyString(body.title, 500)) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (body.id && !isValidUid(body.id)) {
    return res.status(400).json({ error: 'invalid card id' });
  }
  if (body.assigned_staff_id && !isValidUuid(body.assigned_staff_id)) {
    return res.status(400).json({ error: 'invalid assigned_staff_id' });
  }
  if (body.contact_id && !isValidUid(body.contact_id)) {
    return res.status(400).json({ error: 'invalid contact_id' });
  }
  if (body.appointment_id && !isValidUid(body.appointment_id)) {
    return res.status(400).json({ error: 'invalid appointment_id' });
  }

  const valueStr = coerceMoney(body.value);
  if (valueStr === null) {
    return res.status(400).json({ error: 'value must be a non-negative number' });
  }

  const isCreate = !body.id;
  const cardId = body.id || ('crd_' + uid());

  if (isCreate) {
    if (!isValidUid(body.journey_id)) {
      return res.status(400).json({ error: 'journey_id is required' });
    }
    if (!isValidUid(body.stage_id)) {
      return res.status(400).json({ error: 'stage_id is required' });
    }
  }

  try {
    const result = await db.transaction(async (client) => {
      // Cross-tenant validation for foreign refs
      if (body.contact_id) {
        const c = await client.query(
          `SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2`,
          [body.contact_id, subaccountId]
        );
        if (c.rows.length === 0) throw new HttpError(400, 'contact_id does not belong to subaccount');
      }
      if (body.appointment_id) {
        const a = await client.query(
          `SELECT id FROM appointments WHERE id = $1 AND subaccount_id = $2`,
          [body.appointment_id, subaccountId]
        );
        if (a.rows.length === 0) throw new HttpError(400, 'appointment_id does not belong to subaccount');
      }
      if (body.assigned_staff_id) {
        const s = await client.query(
          `SELECT id FROM subaccount_users WHERE id = $1 AND subaccount_id = $2`,
          [body.assigned_staff_id, subaccountId]
        );
        if (s.rows.length === 0) throw new HttpError(400, 'assigned_staff_id does not belong to subaccount');
      }

      if (isCreate) {
        // Validate journey + stage belong to subaccount
        const j = await client.query(
          `SELECT id FROM journeys WHERE id = $1 AND subaccount_id = $2`,
          [body.journey_id, subaccountId]
        );
        if (j.rows.length === 0) throw new HttpError(404, 'Journey not found');

        const s = await client.query(
          `SELECT id, stage_type FROM journey_stages WHERE id = $1 AND journey_id = $2 AND subaccount_id = $3`,
          [body.stage_id, body.journey_id, subaccountId]
        );
        if (s.rows.length === 0) throw new HttpError(404, 'Stage not found in this journey');

        // Determine initial status from stage type
        const stageType = s.rows[0].stage_type;
        const status = stageType === 'won' ? 'won' : (stageType === 'lost' ? 'lost' : 'open');
        const wonAt = stageType === 'won' ? new Date() : null;
        const lostAt = stageType === 'lost' ? new Date() : null;

        // Position: append to end of stage
        const posRes = await client.query(
          `SELECT COALESCE(MAX(position), -1) + 1 AS pos
           FROM journey_cards WHERE stage_id = $1 AND archived = FALSE`,
          [body.stage_id]
        );
        const position = posRes.rows[0].pos;

        await client.query(
          `INSERT INTO journey_cards (
             id, journey_id, stage_id, subaccount_id,
             title, contact_id, appointment_id, assigned_staff_id,
             lead_name, lead_email, lead_phone,
             value, status, position,
             notes, source, expected_close_date,
             won_at, lost_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            cardId, body.journey_id, body.stage_id, subaccountId,
            body.title, body.contact_id || null, body.appointment_id || null, body.assigned_staff_id || null,
            body.lead_name || null, body.lead_email || null, body.lead_phone || null,
            valueStr, status, position,
            body.notes || null, body.source || null, body.expected_close_date || null,
            wonAt, lostAt
          ]
        );

        return { isCreate: true, stage_id: body.stage_id };
      } else {
        // Update path: do NOT allow stage_id change here
        const found = await client.query(
          `SELECT id, stage_id FROM journey_cards WHERE id = $1 AND subaccount_id = $2 FOR UPDATE`,
          [cardId, subaccountId]
        );
        if (found.rows.length === 0) throw new HttpError(404, 'Card not found');

        if (body.stage_id && body.stage_id !== found.rows[0].stage_id) {
          throw new HttpError(400, 'Use journey-cards-move to change stage_id');
        }

        await client.query(
          `UPDATE journey_cards
           SET title = $1,
               contact_id = $2,
               appointment_id = $3,
               assigned_staff_id = $4,
               lead_name = $5,
               lead_email = $6,
               lead_phone = $7,
               value = $8,
               notes = $9,
               source = $10,
               expected_close_date = $11,
               updated_at = NOW()
           WHERE id = $12 AND subaccount_id = $13`,
          [
            body.title,
            body.contact_id || null,
            body.appointment_id || null,
            body.assigned_staff_id || null,
            body.lead_name || null,
            body.lead_email || null,
            body.lead_phone || null,
            valueStr,
            body.notes || null,
            body.source || null,
            body.expected_close_date || null,
            cardId, subaccountId
          ]
        );

        return { isCreate: false, stage_id: found.rows[0].stage_id };
      }
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: result.isCreate ? 'subaccount.journey_card.create' : 'subaccount.journey_card.update',
      targetType: 'journey_card',
      targetId: cardId,
      targetSubaccountId: subaccountId,
      metadata: {
        title: body.title,
        value: parseFloat(valueStr),
        has_contact: !!body.contact_id,
        has_appointment: !!body.appointment_id,
        stage_id: result.stage_id
      }
    });

    return res.status(200).json({ ok: true, id: cardId });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('journey-cards-upsert error:', err);
    return res.status(500).json({ error: 'Failed to save card', detail: err.message });
  }
}

exports.handler = wrap(handler);
