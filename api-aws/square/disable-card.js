// api/square/disable-card.js (Lambda version)
//
// POST /api/square/disable-card
//
// Disables a card on file in Square (Square has no hard delete; DisableCard
// is the canonical removal). Once disabled, the card no longer appears in
// customer-cards.js, which lists with include_disabled=false, so it does not
// reappear on the next drawer refresh.
//
// GUARD (server-enforced, money safety): refuses to disable a card that backs
// a still-chargeable subscription. Chargeable statuses come from the charge
// cron's own update clause (sub-charge.js) plus paused (resumable -> active).
// Staff must swap the card on those subs first.
//
// Body: { slug, customerId, cardId }
// Returns:
//   200 { success:true, cardId }                          on disable
//   409 { error, blocked:true, subscriptions:[...] }      on guard block
//   4xx/5xx { error }                                     on validation/Square error

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./lib/square');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');

// Statuses where the card can still be charged. Mirrors sub-charge.js:320
// (active, trialing, past_due, suspended) plus paused (resume -> active).
const CHARGEABLE = ['active', 'trialing', 'past_due', 'suspended', 'paused'];

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();

  if (slug && auth.subaccount_id !== ('sub-' + slug)) {
    return sendError(res, 403, 'Slug does not match session');
  }

  const effectiveSlug = slug || auth.subaccount_id.replace(/^sub-/, '');
  const customerId = (body.customerId || '').toString().trim();
  const cardId = (body.cardId || '').toString().trim();

  if (!effectiveSlug) return sendError(res, 400, 'Missing slug');
  if (!customerId) return sendError(res, 400, 'Missing customerId');
  if (!cardId) return sendError(res, 400, 'Missing cardId');

  // GUARD: block if any chargeable subscription points at this card.
  // Scoped to this subaccount so no cross-tenant read.
  let blockingSubs = [];
  try {
    const q = await db.query(
      `SELECT s.id, s.status, s.plan_name_snapshot AS plan_name,
              c.display_name AS contact_name
         FROM subscriptions s
         LEFT JOIN contacts c ON c.id = s.contact_id
        WHERE s.subaccount_id = $1
          AND s.card_id = $2
          AND s.status = ANY($3::text[])`,
      [auth.subaccount_id, cardId, CHARGEABLE]
    );
    blockingSubs = q.rows || [];
  } catch (e) {
    console.error('disable-card.js guard query error:', e);
    return sendError(res, 500, 'Could not verify subscription safety: ' + (e.message || 'unknown'));
  }

  if (blockingSubs.length) {
    return res.status(409).json({
      error: 'Card backs an active subscription',
      blocked: true,
      subscriptions: blockingSubs.map(function (s) {
        return { id: s.id, status: s.status, plan: s.plan_name || 'Subscription', contact: s.contact_name || null };
      })
    });
  }

  const creds = await getSquareCreds(effectiveSlug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const host = squareHost(creds.sandbox);
  const headers = squareHeaders(creds.access_token);

  try {
    const r = await fetch('https://' + host + '/v2/cards/' + encodeURIComponent(cardId) + '/disable', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({})
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, r.status, msg, data.errors);
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.card.disable',
      targetType: 'square_card',
      targetId: cardId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { customerId: customerId }
    });

    return res.status(200).json({ success: true, cardId: cardId });
  } catch (err) {
    console.error('disable-card.js error:', err);
    return sendError(res, 500, err.message || 'Disable card failed');
  }
}

exports.handler = wrap(handler);
