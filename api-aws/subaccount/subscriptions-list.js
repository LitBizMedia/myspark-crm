// api/subaccount/subscriptions-list.js (Lambda)
// GET /api/subaccount/subscriptions-list[?contact_id=X][&status=Y][&include_events=true]
// Returns subscriptions for the subaccount, optionally filtered.
// Allowed for any authenticated subaccount user.
//
// When include_events=true, the response includes the most recent 50 events
// for each subscription (used by the History tab on the detail modal).

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { POWER_UP } = require('./lib/roles');
const { wrap } = require('./lib/lambda-adapter');

const VALID_STATUS = ['active', 'trialing', 'paused', 'past_due', 'suspended', 'cancelled'];

function rowToSubscription(row) {
  return {
    id: row.id,
    contactId: row.contact_id,
    planId: row.plan_id,
    planName: row.plan_name_snapshot,
    billingCycle: row.billing_cycle,
    cyclePrice: parseFloat(row.cycle_price),
    items: row.items || [],
    status: row.status,
    startDate: row.start_date,
    nextDueDate: row.next_due_date,
    trialEndsAt: row.trial_ends_at,
    trialReminderSentAt: row.trial_reminder_sent_at,
    lastChargedAt: row.last_charged_at,
    pausedAt: row.paused_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    cardId: row.card_id,
    ownerUserId: row.owner_user_id,
    failedChargeCount: row.failed_charge_count,
    firstFailureAt: row.first_failure_at,
    lastFailureAt: row.last_failure_at,
    lastFailureReason: row.last_failure_reason,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    metadata: row.metadata || {},
    paymentId: row.payment_id,
    createdAt: row.created_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: POWER_UP });
  if (!auth) return;

  const q = req.query || {};
  const contactId = q.contact_id || null;
  const status = q.status || null;
  const includeEvents = q.include_events === 'true' || q.include_events === '1';

  if (status && !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  const params = [auth.subaccount_id];
  let where = 'subaccount_id = $1';
  if (contactId) { params.push(contactId); where += ` AND contact_id = $${params.length}`; }
  if (status)    { params.push(status);    where += ` AND status = $${params.length}`; }

  try {
    const subsResult = await db.query(
      `SELECT * FROM subscriptions WHERE ${where} ORDER BY created_at DESC`,
      params
    );

    const subscriptions = subsResult.rows.map(rowToSubscription);

    // Optional: bulk-fetch recent events for all returned subs.
    // 50-event cap per sub to keep payload reasonable; the History tab
    // can fetch more on demand if needed.
    if (includeEvents && subscriptions.length > 0) {
      const subIds = subscriptions.map(s => s.id);
      const eventsResult = await db.query(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY subscription_id ORDER BY created_at DESC) AS rn
           FROM subscription_events
           WHERE subscription_id = ANY($1::text[])
         ) sub WHERE rn <= 50
         ORDER BY subscription_id, created_at DESC`,
        [subIds]
      );
      const byId = {};
      for (const row of eventsResult.rows) {
        const sid = row.subscription_id;
        if (!byId[sid]) byId[sid] = [];
        byId[sid].push(rowToEvent(row));
      }
      subscriptions.forEach(s => { s.events = byId[s.id] || []; });
    }

    return res.status(200).json({ success: true, subscriptions });
  } catch (e) {
    console.error('subscriptions-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load subscriptions' });
  }
}

exports.handler = wrap(handler);
