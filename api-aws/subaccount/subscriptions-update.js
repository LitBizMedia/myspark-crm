// api/subaccount/subscriptions-update.js (Lambda)
// POST /api/subaccount/subscriptions-update
// Single endpoint for all subscription mutations except hard delete.
// Body: { id, action, ...action-specific fields }
//
// Actions (admin or manager unless otherwise noted):
//   edit                  - update items, notes, owner, card_id (NOT cycle/plan/price)
//   pause                 - admin pause; status -> paused, paused_at = NOW
//   resume                - resume from paused; status -> active
//   cancel                - cancel; status -> cancelled, cancellation_reason recorded
//   change_card           - swap card_id
//   apply_coupon          - apply coupon to sub (one-time or recurring)
//   remove_coupon         - clear coupon fields
//   apply_discount        - apply manual discount (flat or pct)
//   remove_discount       - clear manual discount fields
//   change_owner          - reassign owner_user_id
//   charge_now            - reserved for future stage; rejected here for now
//
// Note on charge_now: this stage doesn't have the charge engine yet. The action
// returns 501 Not Implemented to make the boundary explicit. Stage 4 wires it up.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

// Maps action -> minimum role required.
// Practitioners are always blocked; staff (user) can never modify.
const ACTION_ROLES = {
  edit:           ['admin', 'manager'],
  pause:          ['admin', 'manager'],
  resume:         ['admin', 'manager'],
  cancel:         ['admin', 'manager'],
  change_card:    ['admin', 'manager'],
  apply_coupon:   ['admin', 'manager'],
  remove_coupon:  ['admin', 'manager'],
  apply_discount: ['admin', 'manager'],
  remove_discount:['admin', 'manager'],
  change_owner:   ['admin', 'manager'],
  charge_now:     ['admin', 'manager']  // gated by Stage 4 implementation
};

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, idx) => ({
    id: it.id || `si-${Date.now()}-${idx}`,
    name: String(it.name || '').trim(),
    description: String(it.description || '').trim(),
    taxable: it.taxable !== false,
    qty: it.qty != null ? Math.max(1, parseInt(it.qty, 10) || 1) : 1
  })).filter(it => it.name.length > 0);
}

// Helper: insert a subscription_event row
async function logSubEvent(subaccountId, subscriptionId, eventType, actorUserId, metadata, paymentId) {
  await db.query(
    `INSERT INTO subscription_events (
      id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, payment_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, 'user', $6::jsonb, $7, NOW())`,
    [
      `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      subscriptionId, subaccountId, eventType, actorUserId,
      JSON.stringify(metadata || {}), paymentId || null
    ]
  );
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if (auth.role === 'practitioner') {
    return res.status(403).json({ error: 'Practitioners cannot modify subscriptions' });
  }

  const b = req.body || {};
  const id = b.id;
  const action = b.action;

  if (!id) return res.status(400).json({ error: 'id is required' });
  if (!action || !ACTION_ROLES[action]) return res.status(400).json({ error: 'Invalid or missing action' });

  // Normalize role for permission check (super_admin has admin powers)
  const effectiveRole = auth.role === 'super_admin' ? 'admin' : auth.role;
  if (!ACTION_ROLES[action].includes(effectiveRole)) {
    return res.status(403).json({ error: `Action "${action}" requires one of: ${ACTION_ROLES[action].join(', ')}` });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const existing = await db.query(
      `SELECT * FROM subscriptions WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Subscription not found' });
    const sub = existing.rows[0];

    // Cancelled subs cannot be modified except by hard delete
    if (sub.status === 'cancelled' && action !== 'cancel') {
      // Allow viewing but not modifying. Cancel is a no-op if already cancelled.
      return res.status(409).json({ error: 'Cannot modify a cancelled subscription' });
    }

    let updates = [];
    let params = [];
    let i = 1;
    let eventType = action;
    let eventMeta = {};

    switch (action) {
      case 'edit': {
        // Allowed fields: items, notes, owner_user_id, card_id, ownerUserId
        // FORBIDDEN: cycle, plan_id, cycle_price (price-locked at creation)
        if (Array.isArray(b.items)) {
          const items = normalizeItems(b.items);
          if (items.length === 0) return res.status(400).json({ error: 'At least one item required' });
          updates.push(`items = $${i++}::jsonb`);
          params.push(JSON.stringify(items));
          eventMeta.items_changed = true;
          eventType = 'item_changed';
        }
        if (typeof b.notes === 'string') {
          updates.push(`notes = $${i++}`);
          params.push(b.notes);
          eventMeta.notes_changed = true;
        }
        if (b.ownerUserId !== undefined) {
          updates.push(`owner_user_id = $${i++}`);
          params.push(b.ownerUserId || null);
          eventMeta.owner_changed = true;
          eventType = 'owner_changed';
        }
        if (b.cardId !== undefined) {
          updates.push(`card_id = $${i++}`);
          params.push(b.cardId || null);
          eventMeta.card_changed = true;
          eventType = 'card_changed';
        }
        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
        break;
      }

      case 'pause':
        if (sub.status === 'paused') return res.status(409).json({ error: 'Already paused' });
        updates.push(`status = 'paused'`, `paused_at = NOW()`);
        // Clear suspension fields if pausing from suspended state
        if (sub.status === 'suspended') {
          updates.push(`failed_charge_count = 0`, `last_failure_at = NULL`, `last_failure_reason = NULL`);
          eventMeta.cleared_suspension = true;
        }
        if (b.reason) eventMeta.reason = b.reason;
        break;

      case 'resume':
        if (sub.status !== 'paused' && sub.status !== 'suspended') {
          return res.status(409).json({ error: 'Subscription is not paused or suspended' });
        }
        updates.push(`status = 'active'`, `paused_at = NULL`);
        // Resuming from suspension clears failure tracking; charge engine will retry on next due date.
        if (sub.status === 'suspended') {
          updates.push(`failed_charge_count = 0`, `last_failure_at = NULL`, `last_failure_reason = NULL`);
          eventMeta.cleared_suspension = true;
          eventType = 'resumed_from_suspension';
        }
        break;

      case 'cancel':
        if (sub.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled' });
        updates.push(`status = 'cancelled'`, `cancelled_at = NOW()`);
        if (b.reason) {
          updates.push(`cancellation_reason = $${i++}`);
          params.push(b.reason);
          eventMeta.reason = b.reason;
        }
        break;

      case 'change_card':
        if (!('cardId' in b)) return res.status(400).json({ error: 'cardId is required' });
        updates.push(`card_id = $${i++}`);
        params.push(b.cardId || null);
        eventMeta.new_card_id = b.cardId;
        break;

      case 'apply_coupon': {
        const code = b.couponCode || null;
        const cid = b.couponId || null;
        if (!code && !cid) return res.status(400).json({ error: 'couponId or couponCode required' });
        updates.push(
          `coupon_id = $${i++}`, `coupon_code = $${i++}`, `coupon_recurring = $${i++}`
        );
        params.push(cid, code, !!b.recurring);
        eventMeta = { coupon_code: code, recurring: !!b.recurring };
        eventType = 'coupon_applied';
        break;
      }

      case 'remove_coupon':
        if (!sub.coupon_id && !sub.coupon_code) return res.status(409).json({ error: 'No coupon applied' });
        updates.push(
          `coupon_id = NULL`, `coupon_code = NULL`, `coupon_recurring = FALSE`
        );
        eventMeta = { previous_coupon: sub.coupon_code };
        eventType = 'coupon_removed';
        break;

      case 'apply_discount': {
        const dt = b.discountType;
        const dv = parseFloat(b.discountValue);
        const dn = b.discountNote || '';
        const recurring = b.recurring !== false; // default true
        if (!['flat', 'pct'].includes(dt)) return res.status(400).json({ error: 'discountType must be flat or pct' });
        if (isNaN(dv) || dv < 0) return res.status(400).json({ error: 'discountValue must be >= 0' });
        if (dt === 'pct' && dv > 100) return res.status(400).json({ error: 'discountValue cannot exceed 100 for pct' });
        updates.push(
          `manual_discount_type = $${i++}`,
          `manual_discount_value = $${i++}`,
          `manual_discount_note = $${i++}`,
          `manual_discount_recurring = $${i++}`
        );
        params.push(dt, dv, dn, recurring);
        eventMeta = { type: dt, value: dv, recurring };
        eventType = 'discount_applied';
        break;
      }

      case 'remove_discount':
        if (!sub.manual_discount_type) return res.status(409).json({ error: 'No manual discount applied' });
        updates.push(
          `manual_discount_type = NULL`,
          `manual_discount_value = NULL`,
          `manual_discount_note = NULL`,
          `manual_discount_recurring = TRUE`
        );
        eventMeta = { previous_type: sub.manual_discount_type, previous_value: parseFloat(sub.manual_discount_value || 0) };
        eventType = 'discount_removed';
        break;

      case 'change_owner':
        updates.push(`owner_user_id = $${i++}`);
        params.push(b.ownerUserId || null);
        eventMeta = { new_owner: b.ownerUserId || null, previous_owner: sub.owner_user_id };
        break;

      case 'charge_now':
        // Reserved for Stage 4 (charge engine). Reject explicitly so it's clear.
        return res.status(501).json({ error: 'charge_now is not yet implemented' });

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(id, subaccountId);
    const sql = `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = $${i++} AND subaccount_id = $${i++}`;

    await db.query('BEGIN');
    try {
      await db.query(sql, params);
      await logSubEvent(subaccountId, id, eventType, auth.user_id, eventMeta);
      await db.query('COMMIT');
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: `subaccount.subscription.${action}`,
      targetType: 'subscription',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: { action, ...eventMeta }
    });

    const verify = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    return res.status(200).json({ success: true, subscription: verify.rows[0] });
  } catch (e) {
    console.error('subscriptions-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update subscription' });
  }
}

exports.handler = wrap(handler);
