// api/subaccount/subscriptions-create.js (Lambda)
// POST /api/subaccount/subscriptions-create
// Stage 3.5: subscriptions are multi-item containers.
//
// Body:
//   contactId, billingCycle, startDate (required)
//   items: [{ planId? OR (name, price), qty, taxable, discountType?, discountValue?, discountNote?, discountRecurring? }]
//   cardId?, ownerUserId?, notes?
//
// Coupon and sub-level discount fields are removed in this stage.
// All discount logic is per-item.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const { processSub } = require('./lib/sub-charge');

const VALID_CYCLES = ['weekly', 'monthly', 'quarterly', 'annual'];

function intervalForCycle(cycle) {
  switch (cycle) {
    case 'weekly': return '7 days';
    case 'monthly': return '1 month';
    case 'quarterly': return '3 months';
    case 'annual': return '1 year';
    default: return null;
  }
}

async function buildItem(rawItem, idx, billingCycle, subaccountId, addedAt) {
  if (!rawItem || typeof rawItem !== 'object') {
    throw new Error(`items[${idx}]: must be an object`);
  }
  const qty = Math.max(1, parseInt(rawItem.qty, 10) || 1);
  const discountType = rawItem.discountType || null;
  const discountValue = rawItem.discountValue != null ? parseFloat(rawItem.discountValue) : null;
  const discountNote = String(rawItem.discountNote || '').trim();
  const discountRecurring = rawItem.discountRecurring !== false;

  if (discountType && !['flat', 'pct'].includes(discountType)) {
    throw new Error(`items[${idx}]: discountType must be flat or pct`);
  }
  if (discountType && (discountValue == null || isNaN(discountValue) || discountValue < 0)) {
    throw new Error(`items[${idx}]: discountValue required and >= 0 when discountType is set`);
  }
  if (discountType === 'pct' && discountValue > 100) {
    throw new Error(`items[${idx}]: percent discount cannot exceed 100`);
  }

  let id, planId, name, description, taxable, price;
  if (rawItem.planId) {
    const pRes = await db.query(
      `SELECT * FROM subscription_plans WHERE id = $1 AND subaccount_id = $2`,
      [rawItem.planId, subaccountId]
    );
    if (!pRes.rows.length) throw new Error(`items[${idx}]: plan not found`);
    const plan = pRes.rows[0];
    if (!plan.active) throw new Error(`items[${idx}]: plan "${plan.name}" is deactivated`);
    const cfg = (plan.pricing || {})[billingCycle];
    if (!cfg || !cfg.enabled) {
      throw new Error(`items[${idx}]: plan "${plan.name}" does not offer ${billingCycle} billing`);
    }
    planId = plan.id;
    name = plan.name;
    description = plan.description || '';
    taxable = plan.taxable !== false;
    price = parseFloat(cfg.price);
    id = rawItem.id || `si-${Date.now()}-${idx}-p`;
  } else {
    name = String(rawItem.name || '').trim();
    if (!name) throw new Error(`items[${idx}]: custom item requires name`);
    price = parseFloat(rawItem.price);
    if (isNaN(price) || price <= 0) throw new Error(`items[${idx}]: custom item requires price > 0`);
    description = String(rawItem.description || '').trim();
    taxable = rawItem.taxable !== false;
    planId = null;
    id = rawItem.id || `si-${Date.now()}-${idx}-c`;
  }

  return {
    id, planId, name, description, taxable, price, qty,
    discountType, discountValue, discountNote, discountRecurring,
    addedAt: addedAt || new Date().toISOString(),
    billingEndsAt: null
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const isAdmin = auth.role === 'admin' || auth.role === 'super_admin';
  const isManager = auth.role === 'manager';
  if (!isAdmin && !isManager) {
    return res.status(403).json({ error: 'Only admins and managers can create subscriptions' });
  }

  const b = req.body || {};
  const id = b.id || `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contactId = b.contactId;
  const billingCycle = b.billingCycle;
  const startDate = b.startDate;
  const rawItems = Array.isArray(b.items) ? b.items : [];

  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!startDate) return res.status(400).json({ error: 'startDate is required' });
  if (!VALID_CYCLES.includes(billingCycle)) {
    return res.status(400).json({ error: 'billingCycle must be weekly, monthly, quarterly, or annual' });
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const cRes = await db.query(
      `SELECT 1 FROM subaccount_data
       WHERE subaccount_id = $1
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(data->'contacts', '[]'::jsonb)) AS c
         WHERE c->>'id' = $2
       )`,
      [subaccountId, contactId]
    );
    if (!cRes.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const nowIso = new Date().toISOString();
    const items = [];
    for (let i = 0; i < rawItems.length; i++) {
      try {
        items.push(await buildItem(rawItems[i], i, billingCycle, subaccountId, nowIso));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    const cyclePrice = items.reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (it.qty || 1), 0);

    let planNameSnapshot;
    let planIdForSub;
    const planIds = items.map(it => it.planId).filter(Boolean);
    const uniquePlans = [...new Set(planIds)];
    if (items.length === 1) {
      planNameSnapshot = items[0].name;
      planIdForSub = items[0].planId || null;
    } else if (uniquePlans.length === 1 && planIds.length === items.length) {
      planNameSnapshot = items[0].name;
      planIdForSub = uniquePlans[0];
    } else {
      planNameSnapshot = `Multi-item subscription (${items.length} items)`;
      planIdForSub = null;
    }

    const interval = intervalForCycle(billingCycle);
    void interval; // reserved for future use; not needed now that next_due_date = start_date

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO subscriptions (
          id, subaccount_id, contact_id, plan_id, plan_name_snapshot,
          billing_cycle, cycle_price, items, status, start_date, next_due_date,
          card_id, owner_user_id, notes,
          created_at, updated_at, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8::jsonb, 'active', $9::date, $9::date,
          $10, $11, $12,
          NOW(), NOW(), $13
        )`,
        [
          id, subaccountId, contactId, planIdForSub, planNameSnapshot,
          billingCycle, cyclePrice, JSON.stringify(items), startDate,
          b.cardId || null, b.ownerUserId || null, b.notes || null,
          auth.user_id
        ]
      );

      await db.query(
        `INSERT INTO subscription_events (
          id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
        ) VALUES ($1, $2, $3, 'created', $4, 'user', $5::jsonb, NOW())`,
        [
          `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          id, subaccountId, auth.user_id,
          JSON.stringify({
            plan_id: planIdForSub,
            plan_name: planNameSnapshot,
            cycle: billingCycle,
            cycle_price: cyclePrice,
            item_count: items.length,
            items_summary: items.map(it => ({ name: it.name, price: it.price, qty: it.qty }))
          })
        ]
      );

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
      action: 'subaccount.subscription.create',
      targetType: 'subscription',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {
        contact_id: contactId,
        plan_id: planIdForSub,
        plan_name: planNameSnapshot,
        billing_cycle: billingCycle,
        cycle_price: cyclePrice,
        item_count: items.length
      }
    });

    const verify = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);

    // Immediate charge: if start_date is today or in the past, run the charge
    // synchronously so the customer's first payment hits within seconds of save.
    // Future-dated subs wait for the daily cron.
    let immediateChargeResult = null;
    const todayIso = new Date().toISOString().slice(0, 10);
    if (String(startDate).slice(0, 10) <= todayIso) {
      try {
        const blobRes = await db.query(
          'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
          [subaccountId]
        );
        const blob = { data: blobRes.rows[0]?.data || {} };
        immediateChargeResult = await processSub(verify.rows[0], blob, { dry_run: false });
      } catch (chargeErr) {
        // Don't fail the create if the charge errors out; the daily cron will retry.
        console.error('Immediate charge error:', chargeErr.message);
        immediateChargeResult = { success: false, error: chargeErr.message };
      }
    }

    return res.status(200).json({
      success: true,
      subscription: verify.rows[0],
      immediate_charge: immediateChargeResult
    });
  } catch (e) {
    console.error('subscriptions-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
}

exports.handler = wrap(handler);
