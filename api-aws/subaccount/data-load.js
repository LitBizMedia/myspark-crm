// api/subaccount/data-load.js (Lambda version)
// GET /api/subaccount/data-load
// Loads the bulk subaccount_data JSONB blob plus services, variations, class
// sessions, users, service_categories, service_widgets, payments,
// appointments, subscription_plans, and subscriptions.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

// Maps an appointments table row (snake_case + Date date) to the camelCase
// shape the frontend expects (matching the legacy blob shape).
// Date column is normalized from JS Date object to YYYY-MM-DD string.
function appointmentToFrontend(row) {
  if (!row) return row;
  // Normalize date column (Postgres DATE comes back as a JS Date)
  let dateStr = row.date;
  if (row.date instanceof Date) {
    // Use UTC to avoid timezone drift
    const y = row.date.getUTCFullYear();
    const m = String(row.date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(row.date.getUTCDate()).padStart(2, '0');
    dateStr = `${y}-${m}-${d}`;
  } else if (typeof row.date === 'string' && row.date.length > 10) {
    // ISO-like string; truncate to YYYY-MM-DD
    dateStr = row.date.slice(0, 10);
  }

  return {
    id: row.id,
    title: row.title,
    contactId: row.contact_id,
    assignedTo: row.assigned_to,
    date: dateStr,
    time: row.time,
    duration: row.duration,
    status: row.status,
    location: row.location,
    notes: row.notes,
    buffer_before: row.buffer_before,
    buffer_after: row.buffer_after,
    service_id: row.service_id,
    service_variation_id: row.service_variation_id || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

// Maps a payments table row (snake_case) to the camelCase shape the
// frontend expects (matching the legacy blob shape).
function paymentToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    staffId: row.staff_id,
    staffName: row.staff_name,
    tipStaffId: row.tip_staff_id,
    appointmentId: row.appointment_id,
    classSessionId: row.class_session_id,
    participantContactId: row.participant_contact_id,
    paymentType: row.payment_type,
    parentPaymentId: row.parent_payment_id,
    items: row.items || [],
    subtotal: row.subtotal != null ? parseFloat(row.subtotal) : 0,
    couponDiscount: row.coupon_discount != null ? parseFloat(row.coupon_discount) : 0,
    couponCode: row.coupon_code,
    couponId: row.coupon_id,
    discountAmount: row.discount_amount != null ? parseFloat(row.discount_amount) : 0,
    discountType: row.discount_type,
    discountVal: row.discount_val != null ? parseFloat(row.discount_val) : null,
    discountNote: row.discount_note,
    afterDiscount: row.after_discount != null ? parseFloat(row.after_discount) : null,
    feeAmount: row.fee_amount != null ? parseFloat(row.fee_amount) : 0,
    taxAmount: row.tax_amount != null ? parseFloat(row.tax_amount) : 0,
    taxableAmount: row.taxable_amount != null ? parseFloat(row.taxable_amount) : 0,
    tipAmount: row.tip_amount != null ? parseFloat(row.tip_amount) : 0,
    creditApplied: row.credit_applied != null ? parseFloat(row.credit_applied) : 0,
    total: row.total != null ? parseFloat(row.total) : 0,
    paymentMethod: row.payment_method,
    cardLast4: row.card_last4,
    cardBrand: row.card_brand,
    paymentRef: row.payment_ref,
    failReason: row.fail_reason,
    squarePaymentId: row.square_payment_id,
    squareReceiptUrl: row.square_receipt_url,
    giftCardId: row.gift_card_id,
    giftCardCode: row.gift_card_code,
    giftCardApplied: row.gift_card_applied != null ? parseFloat(row.gift_card_applied) : 0,
    remainderMethod: row.remainder_method,
    remainderRef: row.remainder_ref,
    remainderStatus: row.remainder_status,
    remainderError: row.remainder_error,
    status: row.status,
    refundedAmount: row.refunded_amount != null ? parseFloat(row.refunded_amount) : 0,
    refundedAt: row.refunded_at,
    refundedBy: row.refunded_by,
    isSessionPackSale: !!row.is_session_pack_sale,
    isGiftCardSale: !!row.is_gift_card_sale,
    sessionPackId: row.session_pack_id,
    subscriptionId: row.subscription_id,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

// Maps a subscription_plans row to the camelCase shape the frontend expects.
function planToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    active: row.active,
    categoryId: row.category_id || null,
    taxable: row.taxable !== false,
    items: row.items || [],
    pricing: row.pricing || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by
  };
}

function planCategoryToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by
  };
}

// Maps a subscriptions row to the camelCase shape the frontend expects.
// Mirrors the shape returned by /api/subaccount/subscriptions-list so the
// frontend can use the same render code regardless of which endpoint
// populated db.subscriptions.
function subscriptionToFrontend(row) {
  if (!row) return row;

  // Normalize date columns (start_date and next_due_date are DATE type)
  function dateOnly(d) {
    if (!d) return null;
    if (d instanceof Date) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const da = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${da}`;
    }
    if (typeof d === 'string' && d.length > 10) return d.slice(0, 10);
    return d;
  }

  return {
    id: row.id,
    contactId: row.contact_id,
    planId: row.plan_id,
    planName: row.plan_name_snapshot,
    billingCycle: row.billing_cycle,
    cyclePrice: row.cycle_price != null ? parseFloat(row.cycle_price) : 0,
    items: row.items || [],
    status: row.status,
    startDate: dateOnly(row.start_date),
    nextDueDate: dateOnly(row.next_due_date),
    lastChargedAt: row.last_charged_at instanceof Date ? row.last_charged_at.toISOString() : row.last_charged_at,
    pausedAt: row.paused_at instanceof Date ? row.paused_at.toISOString() : row.paused_at,
    cancelledAt: row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    cardId: row.card_id,
    ownerUserId: row.owner_user_id,
    failedChargeCount: row.failed_charge_count || 0,
    lastFailureAt: row.last_failure_at instanceof Date ? row.last_failure_at.toISOString() : row.last_failure_at,
    lastFailureReason: row.last_failure_reason,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const [
      blobResult, servicesResult, variationsResult, classesResult,
      usersResult, widgetsResult, paymentsResult, appointmentsResult,
      plansResult, subscriptionsResult, planCategoriesResult,
      subscriptionEventsResult
    ] = await Promise.all([
      db.query(
        'SELECT data, service_categories FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM services WHERE subaccount_id = $1 ORDER BY created_at ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT sv.* FROM service_variations sv
         JOIN services s ON sv.service_id = s.id
         WHERE s.subaccount_id = $1
         ORDER BY sv.created_at ASC`,
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM class_sessions WHERE subaccount_id = $1 ORDER BY date ASC, time ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT id, username, display_name, email, role, color, active,
                schedule, date_overrides, must_change_password,
                created_at, updated_at
         FROM subaccount_users
         WHERE subaccount_id = $1
         ORDER BY created_at ASC`,
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM service_widgets WHERE subaccount_id = $1 ORDER BY created_at ASC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM payments WHERE subaccount_id = $1 ORDER BY created_at DESC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM appointments WHERE subaccount_id = $1 ORDER BY date ASC, time ASC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM subscription_plans WHERE subaccount_id = $1 ORDER BY active DESC, name ASC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM subscriptions WHERE subaccount_id = $1 ORDER BY created_at DESC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM subscription_plan_categories WHERE subaccount_id = $1 ORDER BY sort_order ASC, name ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT id, subscription_id, event_type, actor_user_id, actor_type, payment_id, metadata, created_at
         FROM subscription_events
         WHERE subaccount_id = $1
         ORDER BY created_at ASC`,
        [subaccountId]
      )
    ]);

    // Group events by subscription_id and attach to each sub
    const eventsBySubId = {};
    for (const row of subscriptionEventsResult.rows) {
      if (!eventsBySubId[row.subscription_id]) eventsBySubId[row.subscription_id] = [];
      eventsBySubId[row.subscription_id].push({
        id: row.id,
        subscriptionId: row.subscription_id,
        eventType: row.event_type,
        actorUserId: row.actor_user_id,
        actorType: row.actor_type,
        paymentId: row.payment_id,
        metadata: row.metadata || {},
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      });
    }
    const subscriptionsWithEvents = subscriptionsResult.rows.map(row => {
      const sub = subscriptionToFrontend(row);
      sub.events = eventsBySubId[sub.id] || [];
      return sub;
    });

    return res.status(200).json({
      data: blobResult.rows[0]?.data || null,
      services: servicesResult.rows,
      serviceVariations: variationsResult.rows,
      classSessions: classesResult.rows,
      users: usersResult.rows,
      serviceCategories: blobResult.rows[0]?.service_categories || [],
      serviceWidgets: widgetsResult.rows,
      payments: paymentsResult.rows.map(paymentToFrontend),
      appointments: appointmentsResult.rows.map(appointmentToFrontend),
      subscriptionPlans: plansResult.rows.map(planToFrontend),
      subscriptions: subscriptionsWithEvents,
      subscriptionPlanCategories: planCategoriesResult.rows.map(planCategoryToFrontend)
    });
  } catch (e) {
    console.error('data-load error:', e.message);
    return res.status(500).json({ error: 'Failed to load data' });
  }
}

exports.handler = wrap(handler);
