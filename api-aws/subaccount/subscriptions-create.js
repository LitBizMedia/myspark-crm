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
const recurringEmail = require('./lib/recurring-billing-email');
const { wrap } = require('./lib/lambda-adapter');
const { processSub } = require('./lib/sub-charge');
const { chargeSetupFees, writeSetupFeePayment, writePendingSetupFeePayment } = require('./lib/sub-setup-fee');
const { todayInTz, DEFAULT_TZ } = require('./lib/timezone');

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

  let id, planId, name, description, taxable, price, planTrialDays = 0;
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
    planTrialDays = parseInt(plan.trial_days, 10) || 0;
    var _setupFee = (plan.setup_fee_enabled && parseFloat(plan.setup_fee_amount) > 0) ? parseFloat(plan.setup_fee_amount) : 0;
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
    billingEndsAt: null,
    _planTrialDays: planTrialDays,  // transient: stripped before INSERT
    setupFeeAmount: planId ? _setupFee : 0
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
      `SELECT 1 FROM contacts WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
      [contactId, subaccountId]
    );
    if (!cRes.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const nowIso = new Date().toISOString();
    const items = [];
    const planTrialDaysSeen = [];
    for (let i = 0; i < rawItems.length; i++) {
      try {
        const it = await buildItem(rawItems[i], i, billingCycle, subaccountId, nowIso);
        // Capture and strip the transient plan trial signal before storing
        if (it._planTrialDays && it._planTrialDays > 0) planTrialDaysSeen.push(it._planTrialDays);
        delete it._planTrialDays;
        items.push(it);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Trial: take the longest trial offered by any plan-based item. If multi-item
    // sub mixes plans with different trial lengths, customer gets the most generous.
    const trialDays = planTrialDaysSeen.length ? Math.max(...planTrialDaysSeen) : 0;

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

    // Fetch sub timezone upfront. Used for both trial date math and the
    // immediate-charge "today" check.
    let blob;
    try {
      const blobRes = await db.query(
        'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
        [subaccountId]
      );
      blob = { data: blobRes.rows[0]?.data || {} };
    } catch (_) {
      blob = { data: {} };
    }
    const tz = (blob.data.settings && blob.data.settings.timezone) || DEFAULT_TZ;
    const todayInZone = todayInTz(tz);

    // Trial dates: trial begins on max(start_date, today) and ends after
    // trial_days. During trial: status='trialing', next_due_date=trial_ends_at,
    // first charge fires when cron runs on or after trial_ends_at.
    const startStr = String(startDate).slice(0, 10);
    let trialEndsAt = null;
    let initialStatus = 'active';
    let initialNextDue = startStr;

    if (trialDays > 0) {
      const trialStart = startStr > todayInZone ? startStr : todayInZone;
      const [ty, tm, td] = trialStart.split('-').map(Number);
      const endDate = new Date(Date.UTC(ty, tm - 1, td + trialDays));
      trialEndsAt = endDate.toISOString().slice(0, 10);
      initialStatus = 'trialing';
      initialNextDue = trialEndsAt;
    }

    // SETUP FEE: charge BEFORE the transaction. If any plan-based item carries
    // a setup fee, charge Square first. On failure, return 400 with zero DB
    // writes. On success, write the payment record inside the transaction so
    // it stays atomic with the subscription row.
    let setupFeeResult = null;
    const hasAnySetupFee = items.some(it => parseFloat(it.setupFeeAmount) > 0);
    if (hasAnySetupFee) {
      setupFeeResult = await chargeSetupFees({
        subaccountId,
        subId: id,
        contactId,
        cardId: b.cardId,
        ownerUserId: b.ownerUserId,
        items,
        paySettings: blob.data.paySettings || {},
        idempotencyTag: 'create'
      });
      if (!setupFeeResult.success) {
        return res.status(400).json({
          error: 'Setup fee charge failed: ' + (setupFeeResult.error || 'unknown'),
          setup_fee_breakdown: setupFeeResult.breakdown || null
        });
      }
    }

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO subscriptions (
          id, subaccount_id, contact_id, plan_id, plan_name_snapshot,
          billing_cycle, cycle_price, items, status,
          start_date, next_due_date, trial_ends_at,
          card_id, owner_user_id, notes,
          created_at, updated_at, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8::jsonb, $9,
          $10::date, $11::date, $12::date,
          $13, $14, $15,
          NOW(), NOW(), $16
        )`,
        [
          id, subaccountId, contactId, planIdForSub, planNameSnapshot,
          billingCycle, cyclePrice, JSON.stringify(items), initialStatus,
          startDate, initialNextDue, trialEndsAt,
          b.cardId || null, b.ownerUserId || null, b.notes || null,
          auth.user_id
        ]
      );

      await db.query(
        `INSERT INTO subscription_events (
          id, subscription_id, subaccount_id, event_type, actor_user_id, actor_type, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'user', $6::jsonb, NOW())`,
        [
          `sevent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          id, subaccountId,
          trialDays > 0 ? 'trial_started' : 'created',
          auth.user_id,
          JSON.stringify({
            plan_id: planIdForSub,
            plan_name: planNameSnapshot,
            cycle: billingCycle,
            cycle_price: cyclePrice,
            item_count: items.length,
            trial_days: trialDays,
            trial_ends_at: trialEndsAt,
            items_summary: items.map(it => ({ name: it.name, price: it.price, qty: it.qty }))
          })
        ]
      );

      // Setup fee payment record + event, inside the transaction so it commits
      // atomically with the subscription row.
      if (setupFeeResult && setupFeeResult.success && !setupFeeResult.skipped && !setupFeeResult.deferred) {
        // Charged path: real Square payment record
        const setupFeePaymentId = await writeSetupFeePayment(
          {
            subaccountId,
            subId: id,
            contactId,
            ownerUserId: b.ownerUserId
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
              breakdown: setupFeeResult.breakdown
            })
          ]
        );

        setupFeeResult._paymentId = setupFeePaymentId;
      } else if (setupFeeResult && setupFeeResult.success && setupFeeResult.deferred) {
        // Deferred path: no card, write pending payment for manual collection
        const setupFeePaymentId = await writePendingSetupFeePayment(
          {
            subaccountId,
            subId: id,
            contactId,
            ownerUserId: b.ownerUserId
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
              breakdown: setupFeeResult.breakdown
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
        item_count: items.length,
        trial_days: trialDays,
        trial_ends_at: trialEndsAt,
        initial_status: initialStatus
      }
    });

    // Fire patient enrollment notification (non-fatal).
    try {
      if (contactId) {
        const ctx = await recurringEmail._loadContext(subaccountId, contactId);
        if (ctx) {
          await recurringEmail.sendRecurringBillingEmail('enrollment', Object.assign({}, ctx, {
            planName: planNameSnapshot || 'your subscription',
            amount: parseFloat(cyclePrice) || 0,
            billingCycle: billingCycle || '',
            // next_due_date not held in a JS var here. Email composer skips
            // the 'Next charge' row when nextDate is null.
            nextDate: null
          }));
        }
      }
    } catch (rbErr) {
      console.warn('recurring-billing enrollment email failed (non-fatal):', rbErr.message);
    }

    const verify = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);

    // Immediate charge: only fires when sub starts today (in sub's TZ) AND no
    // trial is active. Trialing subs wait for the cron to charge on trial_ends_at.
    let immediateChargeResult = null;
    if (initialStatus !== 'trialing' && startStr <= todayInZone) {
      try {
        immediateChargeResult = await processSub(verify.rows[0], blob, { dry_run: false });
      } catch (chargeErr) {
        console.error('Immediate charge error:', chargeErr.message);
        immediateChargeResult = { success: false, error: chargeErr.message };
      }
    }

    return res.status(200).json({
      success: true,
      subscription: verify.rows[0],
      immediate_charge: immediateChargeResult,
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
    console.error('subscriptions-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
}

exports.handler = wrap(handler);
