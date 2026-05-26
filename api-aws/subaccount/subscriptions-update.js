// api/subaccount/subscriptions-update.js (Lambda)
// POST /api/subaccount/subscriptions-update
// Stage 3.5: per-item operations replace sub-level coupon and discount actions.
//
// Body: { id, action, ...action-specific args }
//
// Actions:
//   - edit: { notes?, ownerUserId? }                Generic small edits
//   - pause: { reason? }                            Status -> paused
//   - resume: {}                                    Status -> active
//   - cancel: { reason }                            Status -> cancelled (terminal)
//   - change_card: { cardId }                       Update card on file
//   - change_owner: { ownerUserId }                 Update owner
//   - add_item: { item }                            Append item to items[]
//   - remove_item: { itemId }                       Remove item from items[]
//   - update_item: { itemId, changes }              Update one item
//
// Stage 4 will add proration on add_item and billingEndsAt on remove_item.
// In Stage 3.5 those actions just modify the array immediately.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const { chargeSetupFees, writeSetupFeePayment, writePendingSetupFeePayment } = require('./lib/sub-setup-fee');
const { processSub, computeCharge } = require('./lib/sub-charge');
const recurringEmail = require('./lib/recurring-billing-email');
const { todayInTz, DEFAULT_TZ } = require('./lib/timezone');

function intervalForCycle(cycle) {
  switch (cycle) {
    case 'weekly': return '7 days';
    case 'monthly': return '1 month';
    case 'quarterly': return '3 months';
    case 'annual': return '1 year';
    default: return '1 month';
  }
}

// Validate and normalize one item being added (catalog or custom)
async function buildItem(rawItem, billingCycle, subaccountId, addedAt) {
  if (!rawItem || typeof rawItem !== 'object') throw new Error('item must be an object');
  const qty = Math.max(1, parseInt(rawItem.qty, 10) || 1);
  const discountType = rawItem.discountType || null;
  const discountValue = rawItem.discountValue != null ? parseFloat(rawItem.discountValue) : null;
  const discountNote = String(rawItem.discountNote || '').trim();
  const discountRecurring = rawItem.discountRecurring !== false;

  if (discountType && !['flat', 'pct'].includes(discountType)) throw new Error('discountType must be flat or pct');
  if (discountType && (discountValue == null || isNaN(discountValue) || discountValue < 0)) {
    throw new Error('discountValue required and >= 0 when discountType is set');
  }
  if (discountType === 'pct' && discountValue > 100) throw new Error('percent discount cannot exceed 100');

  let id, planId, name, description, taxable, price;
  if (rawItem.planId) {
    const pRes = await db.query(
      `SELECT * FROM subscription_plans WHERE id = $1 AND subaccount_id = $2`,
      [rawItem.planId, subaccountId]
    );
    if (!pRes.rows.length) throw new Error('plan not found');
    const plan = pRes.rows[0];
    if (!plan.active) throw new Error(`plan "${plan.name}" is deactivated`);
    const cfg = (plan.pricing || {})[billingCycle];
    if (!cfg || !cfg.enabled) throw new Error(`plan "${plan.name}" does not offer ${billingCycle} billing`);
    planId = plan.id;
    name = plan.name;
    description = plan.description || '';
    taxable = plan.taxable !== false;
    price = parseFloat(cfg.price);
    var _setupFee = (plan.setup_fee_enabled && parseFloat(plan.setup_fee_amount) > 0) ? parseFloat(plan.setup_fee_amount) : 0;
    id = rawItem.id || `si-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-p`;
  } else {
    name = String(rawItem.name || '').trim();
    if (!name) throw new Error('custom item requires name');
    price = parseFloat(rawItem.price);
    if (isNaN(price) || price <= 0) throw new Error('custom item requires price > 0');
    description = String(rawItem.description || '').trim();
    taxable = rawItem.taxable !== false;
    planId = null;
    var _setupFee = 0;
    id = rawItem.id || `si-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-c`;
  }
  return {
    id, planId, name, description, taxable, price, qty,
    discountType, discountValue, discountNote, discountRecurring,
    addedAt: addedAt || new Date().toISOString(),
    billingEndsAt: null,
    setupFeeAmount: planId ? _setupFee : 0
  };
}

function recomputeCyclePrice(items) {
  return (items || []).reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (it.qty || 1), 0);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const isAdmin = auth.role === 'admin' || auth.role === 'super_admin';
  const isManager = auth.role === 'manager';
  if (!isAdmin && !isManager) {
    return res.status(403).json({ error: 'Only admins and managers can update subscriptions' });
  }

  const b = req.body || {};
  const id = b.id;
  const action = b.action;
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (!action) return res.status(400).json({ error: 'action is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const sRes = await db.query(
      `SELECT * FROM subscriptions WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );
    if (!sRes.rows.length) return res.status(404).json({ error: 'Subscription not found' });
    const sub = sRes.rows[0];

    if (sub.status === 'cancelled') {
      return res.status(409).json({ error: 'Cannot modify cancelled subscription' });
    }

    let eventType = null;
    let eventMeta = {};
    let updates = []; // { sql: 'col = $N', value }
    let setupFeeResult = null;  // populated by add_item when plan has setup fee

    switch (action) {
      case 'edit': {
        if (b.notes !== undefined) {
          updates.push({ sql: 'notes = ?', value: String(b.notes || '') });
        }
        if (b.ownerUserId !== undefined) {
          updates.push({ sql: 'owner_user_id = ?', value: b.ownerUserId || null });
        }
        if (!updates.length) return res.status(400).json({ error: 'No fields provided to edit' });
        eventType = 'edited';
        eventMeta = { fields: Object.keys(b).filter(k => k !== 'id' && k !== 'action') };
        break;
      }
      case 'pause': {
        if (sub.status !== 'active' && sub.status !== 'suspended') {
          return res.status(409).json({ error: `Cannot pause from status "${sub.status}"` });
        }
        updates.push({ sql: "status = 'paused'", value: null, raw: true });
        updates.push({ sql: 'paused_at = NOW()', value: null, raw: true });
        eventType = 'paused';
        eventMeta = b.reason ? { reason: String(b.reason) } : {};
        break;
      }
      case 'resume': {
        const fromStatus = sub.status;
        if (!['paused', 'past_due', 'suspended'].includes(fromStatus)) {
          return res.status(409).json({ error: `Cannot resume from status "${fromStatus}"` });
        }

        // Optional card override: admin can pick a different card before resume
        if (b.cardId && b.cardId !== sub.card_id) {
          await db.query(
            `UPDATE subscriptions SET card_id = $1, updated_at = NOW() WHERE id = $2`,
            [b.cardId, sub.id]
          );
          sub.card_id = b.cardId;
        }

        // === Paused path: just flip status, bump next_due_date if past ===
        if (fromStatus === 'paused') {
          updates.push({ sql: "status = 'active'", value: null, raw: true });
          updates.push({ sql: 'paused_at = NULL', value: null, raw: true });
          // If next_due is in the past, push to today + 1 cycle so cron doesn't fire immediately
          const interval = intervalForCycle(sub.billing_cycle);
          updates.push({
            sql: `next_due_date = CASE WHEN next_due_date < CURRENT_DATE THEN (CURRENT_DATE + INTERVAL '${interval}')::date ELSE next_due_date END`,
            value: null, raw: true
          });
          eventType = 'resumed';
          break;
        }

        // === Past_due / Suspended path: attempt charge before resuming ===
        // Load the blob the charge code needs (paySettings, timezone)
        const blobRes = await db.query(
          'SELECT data FROM subaccount_data WHERE subaccount_id = $1',
          [auth.subaccount_id]
        );
        const blob = blobRes.rows[0] || { data: {} };

        // Reload sub fresh in case card_id was just updated
        const freshRes = await db.query('SELECT * FROM subscriptions WHERE id = $1', [sub.id]);
        const freshSub = freshRes.rows[0];

        const chargeResult = await processSub(freshSub, blob, { dry_run: false });

        if (!chargeResult.success && !chargeResult.skipped && !chargeResult.deferred) {
          // Charge failed. State machine in handleChargeFailure already ran:
          // past_due stays past_due (or transitions to suspended on day 4).
          // From suspended, the state machine WILL NOT advance (handleChargeFailure
          // requires status active/trialing/past_due; suspended is terminal there).
          // We need to short-circuit and tell the admin the charge failed.
          return res.status(402).json({
            error: 'Charge attempt failed: ' + (chargeResult.error || 'unknown'),
            charge_failed: true,
            square_error: chargeResult.error,
            from_status: fromStatus
          });
        }

        // Charge succeeded. processSub already advanced status to 'active' and
        // bumped next_due_date by 1 cycle from the ORIGINAL next_due_date.
        // For suspended-recovery, we override next_due_date to today + cycle
        // (treating it as fresh re-enrollment per design).
        if (fromStatus === 'suspended') {
          const interval = intervalForCycle(sub.billing_cycle);
          await db.query(
            `UPDATE subscriptions
             SET next_due_date = (CURRENT_DATE + INTERVAL '${interval}')::date,
                 updated_at = NOW()
             WHERE id = $1`,
            [sub.id]
          );
        }

        eventType = fromStatus === 'suspended' ? 'resumed_from_suspension' : 'resumed_from_past_due';
        eventMeta = {
          from_status: fromStatus,
          charged_total: chargeResult.breakdown ? chargeResult.breakdown.total : null,
          card_id_used: freshSub.card_id,
          card_override: !!(b.cardId && b.cardId !== sub.card_id)
        };

        // Charge already wrote payment + advanced sub. No further `updates` needed.
        // Set updates to empty so the transaction wrapper below is a no-op for this case.
        updates.length = 0;
        break;
      }
      case 'cancel': {
        if (!b.reason) return res.status(400).json({ error: 'reason is required to cancel' });
        updates.push({ sql: "status = 'cancelled'", value: null, raw: true });
        updates.push({ sql: 'cancelled_at = NOW()', value: null, raw: true });
        updates.push({ sql: 'cancellation_reason = ?', value: String(b.reason) });
        eventType = 'cancelled';
        eventMeta = { reason: String(b.reason) };
        break;
      }
      case 'change_card': {
        updates.push({ sql: 'card_id = ?', value: b.cardId || null });
        eventType = 'card_changed';
        eventMeta = { card_id: b.cardId || null };
        break;
      }
      case 'change_owner': {
        updates.push({ sql: 'owner_user_id = ?', value: b.ownerUserId || null });
        eventType = 'owner_changed';
        eventMeta = { owner_user_id: b.ownerUserId || null };
        break;
      }
      case 'add_item': {
        if (!b.item) return res.status(400).json({ error: 'item is required' });
        let newItem;
        try {
          newItem = await buildItem(b.item, sub.billing_cycle, subaccountId, new Date().toISOString());
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }

        // Setup fee: charge BEFORE we queue the UPDATE. On failure, item is not
        // added and the sub is unchanged. On success, the payment record + event
        // get written inside the transaction wrapper below.
        if (parseFloat(newItem.setupFeeAmount) > 0) {
          // Fetch paySettings from blob for tax math
          let payBlob;
          try {
            const blobRes = await db.query(
              'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
              [subaccountId]
            );
            payBlob = blobRes.rows[0]?.data || {};
          } catch (_) {
            payBlob = {};
          }

          setupFeeResult = await chargeSetupFees({
            subaccountId,
            subId: sub.id,
            contactId: sub.contact_id,
            cardId: sub.card_id,
            ownerUserId: sub.owner_user_id,
            items: [newItem],
            paySettings: payBlob.paySettings || {},
            idempotencyTag: 'additem-' + newItem.id
          });
          if (!setupFeeResult.success) {
            return res.status(400).json({
              error: 'Setup fee charge failed: ' + (setupFeeResult.error || 'unknown'),
              setup_fee_breakdown: setupFeeResult.breakdown || null
            });
          }
        }

        const items = [...(sub.items || []), newItem];
        const newCyclePrice = recomputeCyclePrice(items);
        updates.push({ sql: 'items = ?::jsonb', value: JSON.stringify(items) });
        updates.push({ sql: 'cycle_price = ?', value: newCyclePrice });
        eventType = 'item_added';
        eventMeta = { item_id: newItem.id, name: newItem.name, price: newItem.price, qty: newItem.qty };
        break;
      }
      case 'remove_item': {
        const itemId = b.itemId;
        if (!itemId) return res.status(400).json({ error: 'itemId is required' });
        const items = (sub.items || []).filter(it => it.id !== itemId);
        if (items.length === (sub.items || []).length) return res.status(404).json({ error: 'Item not found on this subscription' });
        if (items.length === 0) return res.status(409).json({ error: 'Cannot remove the last item; cancel the subscription instead' });
        const newCyclePrice = recomputeCyclePrice(items);
        updates.push({ sql: 'items = ?::jsonb', value: JSON.stringify(items) });
        updates.push({ sql: 'cycle_price = ?', value: newCyclePrice });
        eventType = 'item_removed';
        const removed = (sub.items || []).find(it => it.id === itemId);
        eventMeta = { item_id: itemId, name: removed?.name, price: removed?.price };
        break;
      }
      case 'update_item': {
        const itemId = b.itemId;
        const changes = b.changes || {};
        if (!itemId) return res.status(400).json({ error: 'itemId is required' });
        const items = (sub.items || []).map(it => it && (typeof it === 'object') ? { ...it } : it);
        const idx = items.findIndex(it => it.id === itemId);
        if (idx === -1) return res.status(404).json({ error: 'Item not found' });
        const item = items[idx];

        // Whitelisted fields
        const allowed = ['qty', 'taxable', 'discountType', 'discountValue', 'discountNote', 'discountRecurring', 'description'];
        const changedKeys = [];
        for (const k of Object.keys(changes)) {
          if (!allowed.includes(k)) continue;
          if (k === 'qty') {
            const q = parseInt(changes[k], 10);
            if (!Number.isFinite(q) || q < 1) return res.status(400).json({ error: 'qty must be >= 1' });
            item[k] = q;
          } else if (k === 'discountType') {
            const v = changes[k];
            if (v && !['flat', 'pct'].includes(v)) return res.status(400).json({ error: 'discountType must be flat or pct' });
            item[k] = v || null;
          } else if (k === 'discountValue') {
            const v = changes[k];
            if (v != null) {
              const n = parseFloat(v);
              if (isNaN(n) || n < 0) return res.status(400).json({ error: 'discountValue must be >= 0' });
              item[k] = n;
            } else {
              item[k] = null;
            }
          } else {
            item[k] = changes[k];
          }
          changedKeys.push(k);
        }
        // Validate combined discount state
        if (item.discountType === 'pct' && item.discountValue > 100) {
          return res.status(400).json({ error: 'percent discount cannot exceed 100' });
        }
        if (item.discountType && (item.discountValue == null || isNaN(item.discountValue))) {
          return res.status(400).json({ error: 'discountValue required when discountType is set' });
        }

        const newCyclePrice = recomputeCyclePrice(items);
        updates.push({ sql: 'items = ?::jsonb', value: JSON.stringify(items) });
        updates.push({ sql: 'cycle_price = ?', value: newCyclePrice });
        eventType = 'item_updated';
        eventMeta = { item_id: itemId, name: item.name, fields: changedKeys };
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    // Build the UPDATE SQL with positional params
    const setClauses = [];
    const params = [];
    let p = 1;
    for (const u of updates) {
      if (u.raw) {
        setClauses.push(u.sql);
      } else {
        setClauses.push(u.sql.replace('?', `$${p}`));
        params.push(u.value);
        p++;
      }
    }
    setClauses.push('updated_at = NOW()');

    const sql = `UPDATE subscriptions SET ${setClauses.join(', ')} WHERE id = $${p++} AND subaccount_id = $${p}`;
    params.push(id, subaccountId);

    // Wrap UPDATE + events + setup fee payment in one transaction.
    // For non-setup-fee paths this is a 1-statement transaction (near-zero cost).
    // For setup fee paths it ensures the UPDATE, the lifecycle event, the
    // setup_fee_charged event, and the payment record all commit atomically.
    await db.query('BEGIN');
    try {
      await db.query(sql, params);

      // Log lifecycle event
      if (eventType) {
        await db.query(
          `INSERT INTO subscription_events (
            id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, 'user', $6::jsonb, NOW())`,
          [
            `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            id, subaccountId, eventType, auth.user_id, JSON.stringify(eventMeta)
          ]
        );
      }

      // Setup fee payment record + event. Two paths: charged (Square ran) or
      // deferred (no card, pending manual collection).
      if (setupFeeResult && setupFeeResult.success && !setupFeeResult.skipped && !setupFeeResult.deferred) {
        const setupFeePaymentId = await writeSetupFeePayment(
          {
            subaccountId,
            subId: id,
            contactId: sub.contact_id,
            ownerUserId: sub.owner_user_id
          },
          setupFeeResult.contact,
          setupFeeResult.card,
          setupFeeResult.breakdown,
          setupFeeResult.squarePayment,
          null
        );

        await db.query(
          `INSERT INTO subscription_events (
            id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, payment_id, metadata, created_at
          ) VALUES ($1, $2, $3, 'setup_fee_charged', $4, 'user', $5, $6::jsonb, NOW())`,
          [
            `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            id, subaccountId,
            auth.user_id,
            setupFeePaymentId,
            JSON.stringify({
              payment_id: setupFeePaymentId,
              square_payment_id: setupFeeResult.squarePayment.id,
              total: setupFeeResult.breakdown.total,
              tax: setupFeeResult.breakdown.taxAmount,
              breakdown: setupFeeResult.breakdown,
              trigger: 'add_item'
            })
          ]
        );

        setupFeeResult._paymentId = setupFeePaymentId;
      } else if (setupFeeResult && setupFeeResult.success && setupFeeResult.deferred) {
        const setupFeePaymentId = await writePendingSetupFeePayment(
          {
            subaccountId,
            subId: id,
            contactId: sub.contact_id,
            ownerUserId: sub.owner_user_id
          },
          setupFeeResult.contact,
          setupFeeResult.breakdown,
          null
        );

        await db.query(
          `INSERT INTO subscription_events (
            id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, payment_id, metadata, created_at
          ) VALUES ($1, $2, $3, 'setup_fee_deferred', $4, 'user', $5, $6::jsonb, NOW())`,
          [
            `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            id, subaccountId,
            auth.user_id,
            setupFeePaymentId,
            JSON.stringify({
              payment_id: setupFeePaymentId,
              total: setupFeeResult.breakdown.total,
              tax: setupFeeResult.breakdown.taxAmount,
              reason: 'manual_processing',
              breakdown: setupFeeResult.breakdown,
              trigger: 'add_item'
            })
          ]
        );

        setupFeeResult._paymentId = setupFeePaymentId;
      }

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
      metadata: eventMeta
    });

    const verify = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);

    // Fire patient notification (non-fatal) for status-change actions.
    // Map subscriptions-update eventType to recurring-billing email event.
    try {
      const RB_EVENT_MAP = {
        paused: 'paused',
        resumed: 'resumed',
        resumed_from_suspension: 'resumed',
        cancelled: 'cancelled'
      };
      const rbEvent = RB_EVENT_MAP[eventType];
      const freshSub = verify.rows[0];
      if (rbEvent && freshSub && freshSub.contact_id) {
        const ctx = await recurringEmail._loadContext(subaccountId, freshSub.contact_id);
        if (ctx) {
          // Load paySettings + tz for accurate amount math
          let lifecycleBlob = { paySettings: {}, settings: {} };
          try {
            const blobRes = await db.query(
              'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
              [auth.subaccount_id]
            );
            lifecycleBlob = blobRes.rows[0]?.data || lifecycleBlob;
          } catch (_) { /* defaults safe */ }
          const lifecycleTz = (lifecycleBlob.settings && lifecycleBlob.settings.timezone) || DEFAULT_TZ;
          const lifecycleBreakdown = computeCharge(freshSub, lifecycleBlob.paySettings || {}, lifecycleTz);
          await recurringEmail.sendRecurringBillingEmail(rbEvent, Object.assign({}, ctx, {
            planName: freshSub.plan_name_snapshot || 'your subscription',
            amount: lifecycleBreakdown.total,
            billingCycle: freshSub.billing_cycle || '',
            nextDate: freshSub.next_due_date || null,
            reason: (eventMeta && eventMeta.reason) || ''
          }));
        }
      }
    } catch (rbErr) {
      console.warn('recurring-billing email send failed (non-fatal):', rbErr.message);
    }

    return res.status(200).json({
      success: true,
      subscription: verify.rows[0],
      setup_fee: setupFeeResult && !setupFeeResult.skipped ? {
        payment_id: setupFeeResult._paymentId || null,
        total: setupFeeResult.breakdown.total,
        tax: setupFeeResult.breakdown.taxAmount,
        subtotal: setupFeeResult.breakdown.subtotal,
        items: setupFeeResult.breakdown.items,
        deferred: !!setupFeeResult.deferred
      } : null
    });
  } catch (e) {
    console.error('subscriptions-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update subscription' });
  }
}

exports.handler = wrap(handler);
