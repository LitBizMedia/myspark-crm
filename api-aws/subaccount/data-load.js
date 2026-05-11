// api/subaccount/data-load.js (Lambda version)
// GET /api/subaccount/data-load
// Loads the bulk subaccount_data JSONB blob plus services, variations, class
// sessions, users, service_categories, service_widgets, payments,
// appointments, subscription_plans, and subscriptions.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

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
    price: row.price != null ? parseFloat(row.price) : null,
    appointment_type_id: row.appointment_type_id || null,
    booked_via: row.booked_via || null,
    widget_id: row.widget_id || null,
    addons: Array.isArray(row.addons) ? row.addons : (row.addons ? row.addons : []),
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
    trialDays: parseInt(row.trial_days, 10) || 0,
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
    trialEndsAt: dateOnly(row.trial_ends_at),
    trialReminderSentAt: row.trial_reminder_sent_at instanceof Date ? row.trial_reminder_sent_at.toISOString() : row.trial_reminder_sent_at,
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

// Maps a contacts row (snake_case) plus nested children to the camelCase
// shape the frontend expects (matching the legacy blob shape).
function contactToFrontend(row, notesByContact, warningsByContact, allergiesByContact, creditByContact) {
  if (!row) return row;
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: row.display_name,
    display_name: row.display_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    title: row.title,
    website: row.website,
    date_of_birth: row.date_of_birth instanceof Date ?
      (function(d){ var y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0'),da=String(d.getUTCDate()).padStart(2,'0'); return y+'-'+m+'-'+da; })(row.date_of_birth) :
      row.date_of_birth,
    gender: row.gender,
    pronouns: row.pronouns,
    preferred_language: row.preferred_language,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state: row.state,
    postal_code: row.postal_code,
    country: row.country,
    timezone: row.timezone,
    emergency_contact_name: row.emergency_contact_name,
    emergency_contact_phone: row.emergency_contact_phone,
    emergency_contact_relationship: row.emergency_contact_relationship,
    source: row.source,
    type: row.type,
    status: row.status,
    archived: !!row.archived,
    tags: row.tags || [],
    customFieldValues: row.custom_field_values || {},
    creditBalance: row.credit_balance != null ? parseFloat(row.credit_balance) : 0,
    squareCustomerId: row.square_customer_id,
    squareCards: row.square_cards || [],
    notes: (notesByContact[row.id] || []),
    warnings: (warningsByContact[row.id] || []),
    allergies: (allergiesByContact[row.id] || []),
    creditHistory: (creditByContact[row.id] || []),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const [
      blobResult, servicesResult, variationsResult, addonsResult, classesResult,
      usersResult, widgetsResult, paymentsResult, appointmentsResult, apptClientsResult, apptStaffResult,
      plansResult, subscriptionsResult, planCategoriesResult,
      subscriptionEventsResult, resourcesResult, groupsResult, groupMembersResult,
      contactsResult, contactNotesResult, contactWarningsResult, contactAllergiesResult, contactCreditLogResult
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
        `SELECT id, service_id, subaccount_id, name, description, price,
                duration_add, active, display_order, created_at, updated_at
         FROM service_addons
         WHERE subaccount_id = $1
         ORDER BY service_id ASC, display_order ASC, name ASC`,
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
      // Group booking: clients per appointment (for multi-client appointments)
      db.query(
        `SELECT ac.appointment_id, ac.contact_id, ac.is_primary
         FROM appointment_clients ac
         JOIN appointments a ON a.id = ac.appointment_id
         WHERE a.subaccount_id = $1`,
        [subaccountId]
      ),
      // Group booking: staff per appointment (for multi-staff appointments)
      db.query(
        `SELECT ast.appointment_id, ast.staff_id, ast.display_order
         FROM appointment_staff ast
         JOIN appointments a ON a.id = ast.appointment_id
         WHERE a.subaccount_id = $1
         ORDER BY ast.display_order`,
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
    ,
      // Resources for this subaccount, ordered by display_order then name.
      db.query(
        `SELECT id, subaccount_id, name, type, capacity, buffer_after,
                active, display_order, notes, created_at, updated_at
         FROM resources
         WHERE subaccount_id = $1
         ORDER BY COALESCE(display_order, 9999), name`,
        [subaccountId]
      ),
      // Service resource groups
      db.query(
        `SELECT id, service_id, display_order
         FROM service_resource_groups
         WHERE subaccount_id = $1
         ORDER BY service_id, display_order, id`,
        [subaccountId]
      ),
      // Members of each group
      db.query(
        `SELECT m.group_id, m.resource_id, m.display_order
         FROM service_resource_group_members m
         JOIN service_resource_groups g ON m.group_id = g.id
         WHERE g.subaccount_id = $1
         ORDER BY m.display_order`,
        [subaccountId]
      ),
      // Contacts (migrated to RDS in Session 2 of contacts migration)
      db.query(
        `SELECT id, subaccount_id,
                first_name, last_name, display_name,
                email, phone, company, title, website,
                date_of_birth, gender, pronouns, preferred_language,
                address_line1, address_line2, city, state, postal_code, country, timezone,
                emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                source, type, status, archived,
                tags, custom_field_values,
                credit_balance,
                square_customer_id, square_cards,
                created_at, updated_at, created_by, updated_by
         FROM contacts
         WHERE subaccount_id = $1
         ORDER BY created_at ASC`,
        [subaccountId]
      ),
      // Contact notes
      db.query(
        `SELECT id, contact_id, text, author_id, author_name, created_at, updated_at
         FROM contact_notes
         WHERE subaccount_id = $1
         ORDER BY created_at DESC`,
        [subaccountId]
      ),
      // Contact warnings
      db.query(
        `SELECT id, contact_id, severity, text, created_at, created_by, updated_at, updated_by
         FROM contact_warnings
         WHERE subaccount_id = $1
         ORDER BY
           CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
           created_at DESC`,
        [subaccountId]
      ),
      // Contact allergies
      db.query(
        `SELECT id, contact_id, allergen, reaction, severity, notes, created_at, created_by, updated_at, updated_by
         FROM contact_allergies
         WHERE subaccount_id = $1
         ORDER BY
           CASE severity WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 WHEN 'mild' THEN 2 ELSE 3 END,
           allergen ASC`,
        [subaccountId]
      ),
      // Contact credit log
      db.query(
        `SELECT id, contact_id, amount, type, reason, payment_id, balance_after, created_at, created_by
         FROM contact_credit_log
         WHERE subaccount_id = $1
         ORDER BY created_at DESC`,
        [subaccountId]
      )]);

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

    // Audit: bulk PHI access. Log aggregate counts, not contents, to
    // satisfy HIPAA observability without exploding audit_log volume.
    try {
      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: 'subaccount.data.bulk_load',
        targetType: 'bulk_data',
        targetSubaccountId: subaccountId,
        metadata: {
          contact_count: contactsResult.rows.length,
          contact_warning_count: contactWarningsResult.rows.length,
          contact_allergy_count: contactAllergiesResult.rows.length,
          contact_note_count: contactNotesResult.rows.length,
          appointment_count: appointmentsResult.rows.length,
          payment_count: paymentsResult.rows.length,
          service_count: servicesResult.rows.length
        }
      });
    } catch (e) { console.warn('audit log failed (data-load):', e.message); }

    // Bucket contact children by contact_id for nesting
    var notesByContact = {};
    for (var ni = 0; ni < contactNotesResult.rows.length; ni++) {
      var n = contactNotesResult.rows[ni];
      if (!notesByContact[n.contact_id]) notesByContact[n.contact_id] = [];
      notesByContact[n.contact_id].push({
        id: n.id,
        contact_id: n.contact_id,
        text: n.text,
        author_id: n.author_id,
        author_name: n.author_name,
        created_at: n.created_at instanceof Date ? n.created_at.toISOString() : n.created_at,
        updated_at: n.updated_at instanceof Date ? n.updated_at.toISOString() : n.updated_at
      });
    }
    var warningsByContact = {};
    for (var wi = 0; wi < contactWarningsResult.rows.length; wi++) {
      var w = contactWarningsResult.rows[wi];
      if (!warningsByContact[w.contact_id]) warningsByContact[w.contact_id] = [];
      warningsByContact[w.contact_id].push({
        id: w.id,
        contact_id: w.contact_id,
        severity: w.severity,
        text: w.text,
        created_at: w.created_at instanceof Date ? w.created_at.toISOString() : w.created_at,
        created_by: w.created_by,
        updated_at: w.updated_at instanceof Date ? w.updated_at.toISOString() : w.updated_at,
        updated_by: w.updated_by
      });
    }
    var allergiesByContact = {};
    for (var ai = 0; ai < contactAllergiesResult.rows.length; ai++) {
      var a = contactAllergiesResult.rows[ai];
      if (!allergiesByContact[a.contact_id]) allergiesByContact[a.contact_id] = [];
      allergiesByContact[a.contact_id].push({
        id: a.id,
        contact_id: a.contact_id,
        allergen: a.allergen,
        reaction: a.reaction,
        severity: a.severity,
        notes: a.notes,
        created_at: a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at,
        created_by: a.created_by,
        updated_at: a.updated_at instanceof Date ? a.updated_at.toISOString() : a.updated_at,
        updated_by: a.updated_by
      });
    }
    var creditByContact = {};
    for (var ci = 0; ci < contactCreditLogResult.rows.length; ci++) {
      var cl = contactCreditLogResult.rows[ci];
      if (!creditByContact[cl.contact_id]) creditByContact[cl.contact_id] = [];
      creditByContact[cl.contact_id].push({
        id: cl.id,
        contact_id: cl.contact_id,
        amount: parseFloat(cl.amount),
        type: cl.type,
        reason: cl.reason,
        payment_id: cl.payment_id,
        balance_after: parseFloat(cl.balance_after),
        created_at: cl.created_at instanceof Date ? cl.created_at.toISOString() : cl.created_at,
        created_by: cl.created_by
      });
    }

    return res.status(200).json({
      data: blobResult.rows[0]?.data || null,
      contacts: contactsResult.rows.map(function(row){
        return contactToFrontend(row, notesByContact, warningsByContact, allergiesByContact, creditByContact);
      }),
      services: servicesResult.rows,
      serviceVariations: variationsResult.rows,
      serviceAddons: addonsResult.rows,
      resources: (resourcesResult && resourcesResult.rows) || [],
      serviceResourceGroups: (function(){
        // Bucket groups by service_id with their resource_ids nested.
        var groups = (groupsResult && groupsResult.rows) || [];
        var members = (groupMembersResult && groupMembersResult.rows) || [];
        var byGroup = {};
        for (var i = 0; i < members.length; i++) {
          var m = members[i];
          if (!byGroup[m.group_id]) byGroup[m.group_id] = [];
          byGroup[m.group_id].push(m.resource_id);
        }
        var byService = {};
        for (var j = 0; j < groups.length; j++) {
          var g = groups[j];
          if (!byService[g.service_id]) byService[g.service_id] = [];
          byService[g.service_id].push({
            id: g.id,
            display_order: g.display_order,
            resource_ids: byGroup[g.id] || []
          });
        }
        return byService;
      })(),
      classSessions: classesResult.rows,
      users: usersResult.rows,
      serviceCategories: blobResult.rows[0]?.service_categories || [],
      serviceWidgets: widgetsResult.rows,
      payments: paymentsResult.rows.map(paymentToFrontend),
      appointments: (function(){
        // Bucket clients and staff by appointment_id for joining.
        var clientRows = (apptClientsResult && apptClientsResult.rows) || [];
        var staffRows = (apptStaffResult && apptStaffResult.rows) || [];
        var clientsByAppt = {};
        for (var i = 0; i < clientRows.length; i++) {
          var c = clientRows[i];
          if (!clientsByAppt[c.appointment_id]) clientsByAppt[c.appointment_id] = [];
          clientsByAppt[c.appointment_id].push({ contact_id: c.contact_id, is_primary: c.is_primary });
        }
        var staffByAppt = {};
        for (var j = 0; j < staffRows.length; j++) {
          var s = staffRows[j];
          if (!staffByAppt[s.appointment_id]) staffByAppt[s.appointment_id] = [];
          staffByAppt[s.appointment_id].push({ staff_id: s.staff_id, display_order: s.display_order });
        }
        return appointmentsResult.rows.map(function(row){
          var appt = appointmentToFrontend(row);
          appt.clients = clientsByAppt[row.id] || [];
          appt.staff = staffByAppt[row.id] || [];
          return appt;
        });
      })(),
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
