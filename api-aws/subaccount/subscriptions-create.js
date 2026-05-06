// api/subaccount/subscriptions-create.js (Lambda)
// POST /api/subaccount/subscriptions-create
// Creates a new subscription. Admin or manager only.
//
// Body: {
//   id?, contactId, planId?, billingCycle, items?, startDate,
//   cardId?, couponId?, couponCode?, couponRecurring?,
//   manualDiscountType?, manualDiscountValue?, manualDiscountNote?, manualDiscountRecurring?,
//   ownerUserId?, notes?,
//   customPlanName?,    // for custom mode (no planId)
//   customCyclePrice?   // for custom mode
// }
//
// Snapshot rules (price-locked at creation, your choice A):
//   - If planId is given: plan_name_snapshot, cycle_price, items copied from the plan
//   - If planId is null (custom): customPlanName, customCyclePrice, items required from body

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_CYCLES = ['weekly', 'monthly', 'quarterly', 'annual'];

// Compute next_due_date by adding the cycle interval to start_date.
// We use SQL date arithmetic in the INSERT instead of doing it in JS to avoid
// timezone issues. This helper is used only for validation pre-check.
function intervalForCycle(cycle) {
  switch (cycle) {
    case 'weekly': return '7 days';
    case 'monthly': return '1 month';
    case 'quarterly': return '3 months';
    case 'annual': return '1 year';
    default: return null;
  }
}

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

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  // Admin or manager only. Staff (user) and practitioner cannot create.
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

  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!startDate) return res.status(400).json({ error: 'startDate is required' });
  if (!VALID_CYCLES.includes(billingCycle)) {
    return res.status(400).json({ error: 'billingCycle must be weekly, monthly, quarterly, or annual' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    // Verify contact exists and belongs to this subaccount
    const cRes = await db.query(
      `SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2`,
      [contactId, subaccountId]
    );
    if (!cRes.rows.length) return res.status(404).json({ error: 'Contact not found' });

    let planId = b.planId || null;
    let planNameSnapshot;
    let cyclePrice;
    let items;

    if (planId) {
      // Catalog mode: snapshot from the plan
      const pRes = await db.query(
        `SELECT * FROM subscription_plans WHERE id = $1 AND subaccount_id = $2`,
        [planId, subaccountId]
      );
      if (!pRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
      const plan = pRes.rows[0];
      if (!plan.active) return res.status(409).json({ error: 'Plan is deactivated' });
      const cycleConfig = (plan.pricing || {})[billingCycle];
      if (!cycleConfig || !cycleConfig.enabled) {
        return res.status(400).json({ error: `Plan does not offer ${billingCycle} billing` });
      }
      planNameSnapshot = plan.name;
      cyclePrice = parseFloat(cycleConfig.price);
      items = plan.items || [];
    } else {
      // Custom mode: take name and price from body
      planNameSnapshot = String(b.customPlanName || '').trim();
      cyclePrice = parseFloat(b.customCyclePrice);
      items = normalizeItems(b.items);
      if (!planNameSnapshot) return res.status(400).json({ error: 'customPlanName required when no planId' });
      if (isNaN(cyclePrice) || cyclePrice <= 0) return res.status(400).json({ error: 'customCyclePrice must be > 0' });
      if (items.length === 0) return res.status(400).json({ error: 'At least one item required for custom subscription' });
    }

    // Optional discount validation
    const mdt = b.manualDiscountType || null;
    if (mdt && !['flat', 'pct'].includes(mdt)) {
      return res.status(400).json({ error: 'manualDiscountType must be flat or pct' });
    }
    const mdv = b.manualDiscountValue != null ? parseFloat(b.manualDiscountValue) : null;
    if (mdt && (mdv == null || isNaN(mdv) || mdv < 0)) {
      return res.status(400).json({ error: 'manualDiscountValue required when type is set' });
    }
    if (mdt === 'pct' && mdv > 100) {
      return res.status(400).json({ error: 'manualDiscountValue cannot exceed 100 for pct type' });
    }

    const interval = intervalForCycle(billingCycle);

    // Use a transaction so subscription + initial event are atomic
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO subscriptions (
          id, subaccount_id, contact_id, plan_id, plan_name_snapshot,
          billing_cycle, cycle_price, items, status, start_date, next_due_date,
          card_id, coupon_id, coupon_code, coupon_recurring,
          manual_discount_type, manual_discount_value, manual_discount_note, manual_discount_recurring,
          owner_user_id, notes, created_at, updated_at, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8::jsonb, 'active', $9::date, ($9::date + INTERVAL '${interval}'),
          $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, NOW(), NOW(), $20
        )`,
        [
          id, subaccountId, contactId, planId, planNameSnapshot,
          billingCycle, cyclePrice, JSON.stringify(items), startDate,
          b.cardId || null, b.couponId || null, b.couponCode || null, !!b.couponRecurring,
          mdt, mdv, b.manualDiscountNote || null,
          b.manualDiscountRecurring !== false,  // default true
          b.ownerUserId || null, b.notes || null, auth.user_id
        ]
      );

      // Log creation event to subscription_events for the History tab
      await db.query(
        `INSERT INTO subscription_events (
          id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
        ) VALUES ($1, $2, $3, 'created', $4, 'user', $5::jsonb, NOW())`,
        [
          `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          id, subaccountId, auth.user_id,
          JSON.stringify({
            plan_id: planId, plan_name: planNameSnapshot,
            cycle: billingCycle, cycle_price: cyclePrice, item_count: items.length,
            custom: !planId
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
        contact_id: contactId, plan_id: planId, plan_name: planNameSnapshot,
        billing_cycle: billingCycle, cycle_price: cyclePrice
      }
    });

    const verify = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    return res.status(200).json({ success: true, subscription: verify.rows[0] });
  } catch (e) {
    console.error('subscriptions-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
}

exports.handler = wrap(handler);
