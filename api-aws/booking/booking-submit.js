// api/booking/booking-submit.js
// POST /api/booking/submit
// PUBLIC - no auth required
// Creates an appointment from a public booking widget.
//
// Payment flow:
//   1. Validate inputs (slug, service, date/time, contact, etc.)
//   2. Race-check the time slot
//   3. If widget requires payment OR coupon used:
//      a. Validate coupon if provided
//      b. Compute final total: subtotal - coupon - discount + tax + tip
//      c. Charge via Square (sandbox/prod based on widget settings)
//      d. If charge fails, NOTHING gets created (no appointment, no contact, no payment)
//   4. Create/find contact in contacts table (NOT blob)
//   5. Create appointment in appointments table (NOT blob)
//   6. Create payment record in payments table (matches MySpark Payment Policy schema)
//   7. Log coupon usage if applicable
//   8. Audit log
//   9. Send confirmation email
//
// Stage 4 will add: round robin staff selection, intake form responses, reschedule/cancel.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const resend = require('./lib/resend');
const { getSquareCreds, squareHost, squareHeaders } = require('./lib/square');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const now_ = () => new Date().toISOString();

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// Friendly timezone label, mirrors the booking-widget tzLabel helper.
const TZ_LABELS = {
  'America/New_York':'Eastern Time','America/Chicago':'Central Time',
  'America/Denver':'Mountain Time','America/Phoenix':'Mountain Time (Arizona)',
  'America/Los_Angeles':'Pacific Time','America/Anchorage':'Alaska Time',
  'Pacific/Honolulu':'Hawaii Time','America/Toronto':'Eastern Time',
  'America/Vancouver':'Pacific Time','Europe/London':'London Time',
  'Europe/Paris':'Central European Time','Europe/Berlin':'Central European Time',
  'Asia/Tokyo':'Japan Time','Asia/Shanghai':'China Time','Asia/Kolkata':'India Time',
  'Asia/Dubai':'Gulf Time','Australia/Sydney':'Sydney Time','Pacific/Auckland':'New Zealand Time'
};
function tzLabel(iana){
  if(!iana)return '';
  return TZ_LABELS[iana] || iana.split('/').pop().replace(/_/g,' ');
}

function r2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

// Tax computation matching MySpark Payment Policy.
// Single-line allocation: pack/appt/class are treated as single line items.
function calcTax(subtotal, taxableFlag, preTaxDiscount, taxSettings) {
  if (!taxSettings || !taxSettings.enabled || !taxSettings.rate || taxSettings.rate <= 0) {
    return { tax: 0, taxableAmount: 0 };
  }
  if (!taxableFlag) {
    return { tax: 0, taxableAmount: 0 };
  }
  const taxableAmount = Math.max(0, r2(subtotal - (preTaxDiscount || 0)));
  const tax = r2(taxableAmount * taxSettings.rate / 100);
  return { tax, taxableAmount };
}

async function sendConfirmationEmail(slug, to, subject, html, bizName, contactId) {
  try {
    const result = await resend.sendEmail(slug, {
      to, subject, html,
      fromName: bizName || 'MySpark+',
      templateType: 'booking-confirmation',
      contactId: contactId || null
    });
    if (!result.ok) console.error('Confirmation email failed:', result.error);
  } catch (e) {
    console.error('Confirmation email failed:', e.message);
  }
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Honeypot: silently succeed to confuse bots
  if (body._hp) return res.status(200).json({ success: true, id: uid() });

  const {
    slug,
    widget_id,
    service_id,
    variation_id,
    appointment_type_id,
    class_session_id,
    staff_id,
    date,
    time,
    client_info,
    square_nonce,
    coupon_code,
    tip_amount
  } = body;

  // Input validation. Service widgets pass service_id; appointment widgets pass
  // appointment_type_id; class widgets pass class_session_id (date/time/staff
  // come from the session). Exactly one identifier must be present.
  if (!slug)
    return res.status(400).json({ error: 'slug is required' });
  const idCount = [service_id, appointment_type_id, class_session_id].filter(Boolean).length;
  if (idCount === 0)
    return res.status(400).json({ error: 'service_id, appointment_type_id, or class_session_id is required' });
  if (idCount > 1)
    return res.status(400).json({ error: 'cannot specify multiple booking identifiers' });
  // Class bookings have date/time/staff baked into the session row; everyone else needs them in the request.
  if (!class_session_id) {
    if (!date || !time)
      return res.status(400).json({ error: 'date and time are required' });
  }
  if (!client_info?.name || !client_info?.email)
    return res.status(400).json({ error: 'Client name and email are required' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });
  if (time && !/^\d{2}:\d{2}$/.test(time))
    return res.status(400).json({ error: 'Invalid time format' });
  if (!/^[a-z0-9-]{1,64}$/i.test(slug))
    return res.status(400).json({ error: 'invalid slug format' });

  try {
    // 1. Subaccount lookup
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Widget lookup (if widget_id provided, validate it; this also tells us if payment is required)
    let widget = null;
    if (widget_id) {
      const wResult = await db.query(
        `SELECT id, name, widget_type, service_ids, staff_mode, staff_ids,
                appointment_types, round_robin_config, require_payment, confirm_message,
                payment_mode, deposit_type, deposit_value,
                allow_coupons, allow_tip, tip_percentages,
                collect_phone, collect_notes, require_existing_patient,
                send_confirmation_email,
                booking_lead_time_hours, booking_advance_days,
                buffer_before_override, buffer_after_override
         FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = TRUE LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wResult.rows.length) {
        return res.status(404).json({ error: 'Widget not found or inactive' });
      }
      widget = wResult.rows[0];

      // Validate widget type matches what was sent
      if (widget.widget_type === 'service' && (appointment_type_id || class_session_id)) {
        return res.status(400).json({ error: 'This widget does not support that booking type' });
      }
      if (widget.widget_type === 'appointment' && (service_id || class_session_id)) {
        return res.status(400).json({ error: 'This widget does not support that booking type' });
      }
      if (widget.widget_type === 'class' && (service_id || appointment_type_id)) {
        return res.status(400).json({ error: 'This widget only supports class registrations' });
      }

      // For service widgets, verify the service is allowed
      if (widget.widget_type === 'service' &&
          Array.isArray(widget.service_ids) && widget.service_ids.length &&
          !widget.service_ids.includes(service_id)) {
        return res.status(400).json({ error: 'Service not available on this widget' });
      }

      // 2a. Per-widget patient form validations.
      // collect_phone: if true (default), phone is required.
      if (widget.collect_phone !== false && !(client_info && client_info.phone && String(client_info.phone).trim())) {
        return res.status(400).json({ error: 'Phone number is required' });
      }
    }

    // 3. Look up the bookable item: either a service OR an appointment type.
    // Both branches produce the same downstream values (basePrice, duration, etc.)
    // so the rest of the function can treat them uniformly.
    let service = null;          // null for appointment widgets and class widgets
    let appointmentType = null;  // null for service widgets and class widgets
    let classSession = null;     // null for service and appointment widgets
    let title = '';
    let duration = 60;
    let bufBefore = 0;
    let bufAfter = 0;
    let basePrice = 0;
    let taxableFlag = true;
    let varName = '';

    if (class_session_id) {
      // Class widget path: session is the source of truth for date/time/duration/instructor.
      // Capacity check happens later inside a transaction so we don't oversell.
      const csResult = await db.query(
        `SELECT id, service_id, instructor_id, title, date, time, duration,
                capacity, location, status, price, participants
         FROM class_sessions
         WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
        [class_session_id, subaccountId]
      );
      if (!csResult.rows.length) return res.status(404).json({ error: 'Class session not found' });
      classSession = csResult.rows[0];
      if (classSession.status === 'cancelled') {
        return res.status(400).json({ error: 'This class session has been cancelled' });
      }
      // Look up the parent service for taxable flag (price comes from session, not service)
      const svcResult = await db.query(
        'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 LIMIT 1',
        [classSession.service_id, subaccountId]
      );
      if (!svcResult.rows.length) return res.status(404).json({ error: 'Class service not found' });
      service = svcResult.rows[0];
      if (service.type !== 'class') {
        return res.status(400).json({ error: 'Service is not a class' });
      }

      title       = classSession.title || service.name || 'Class';
      duration    = parseInt(classSession.duration) || parseInt(service.duration_default) || 60;
      basePrice   = parseFloat(classSession.price);
      if (isNaN(basePrice) || basePrice == null) basePrice = parseFloat(service.price) || 0;
      taxableFlag = service.taxable !== false;
      // Buffer doesn't apply to class sessions - they're fixed time blocks
      bufBefore   = 0;
      bufAfter    = 0;
    } else if (appointment_type_id) {
      // Appointment widget path
      if (!widget) return res.status(400).json({ error: 'Widget required for appointment booking' });
      const types = Array.isArray(widget.appointment_types) ? widget.appointment_types : [];
      appointmentType = types.find(t => t && t.id === appointment_type_id && t.active !== false);
      if (!appointmentType) {
        return res.status(404).json({ error: 'Appointment type not found or inactive' });
      }
      title       = appointmentType.name || 'Appointment';
      duration    = parseInt(appointmentType.duration) || 30;
      bufBefore   = parseInt(appointmentType.buffer_before) || 0;
      bufAfter    = parseInt(appointmentType.buffer_after) || 0;
      basePrice   = parseFloat(appointmentType.price) || 0;
      taxableFlag = appointmentType.taxable !== false;
    } else {
      // Service widget path
      const svcResult = await db.query(
        'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1',
        [service_id, subaccountId]
      );
      if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });
      service = svcResult.rows[0];

      duration  = service.duration_default || 60;
      bufBefore = service.buffer_before    || 0;
      bufAfter  = service.buffer_after     || 0;
      basePrice = service.price != null ? parseFloat(service.price) : 0;
      taxableFlag = service.taxable !== false;

      // Variation overrides
      if (variation_id) {
        const varResult = await db.query(
          'SELECT * FROM service_variations WHERE id = $1 AND service_id = $2 LIMIT 1',
          [variation_id, service_id]
        );
        if (varResult.rows.length) {
          const v = varResult.rows[0];
          duration  = v.duration             || duration;
          bufBefore = v.buffer_before != null ? v.buffer_before : bufBefore;
          bufAfter  = v.buffer_after  != null ? v.buffer_after  : bufAfter;
          basePrice = v.price         != null ? parseFloat(v.price) : basePrice;
          varName   = v.name || '';
        }
      }

      title = service.name + (varName ? ` - ${varName}` : '');
    }

    // Per-widget buffer overrides take precedence when set.
    // NULL on the column means "use the default from service/variation/appt-type".
    if (widget) {
      if (widget.buffer_before_override != null) bufBefore = parseInt(widget.buffer_before_override) || 0;
      if (widget.buffer_after_override  != null) bufAfter  = parseInt(widget.buffer_after_override)  || 0;
    }

    // 5. Read settings (for tax, square, confirmation email)
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const bs       = settings.bookingSettings || {};
    const paySettings = settings.paySettings || {};
    const taxSettings = paySettings.tax || bs.tax || { enabled: false, rate: 0, label: 'Sales Tax' };

    // 6. Resolve assigned staff (eligible pool).
    //
    // Per MySpark-Booking-Widget-Spec:
    // - Service widgets INHERIT staff from service.assigned_staff. widget.staff_ids ignored.
    // - Appointment widgets use widget.staff_ids directly. There is no service.
    const widgetType = (widget && widget.widget_type) || 'service';

    let assignedStaffId;
    let bookingDate;
    let bookingTime;
    let allUsers = [];   // staff list, populated for non-class flows; needed later for email

    if (classSession) {
      // Class booking: instructor and time come from the session. Skip the
      // appointment-widget staff resolution entirely. The session row is the
      // source of truth.
      assignedStaffId = classSession.instructor_id || null;
      bookingDate     = classSession.date;          // session date
      bookingTime     = classSession.time;          // session time
      if (typeof bookingDate === 'object' && bookingDate instanceof Date) {
        bookingDate = bookingDate.toISOString().slice(0, 10);
      }
      // Look up the instructor for the confirmation email
      if (assignedStaffId) {
        const instrRes = await db.query(
          `SELECT id, username, display_name FROM subaccount_users
           WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
          [assignedStaffId, subaccountId]
        );
        if (instrRes.rows.length) {
          const u = instrRes.rows[0];
          allUsers.push({ id: u.id, name: u.display_name || u.username });
        }
      }
    } else {
      // Service and appointment widgets: resolve staff per widget config.
      bookingDate = date;
      bookingTime = time;

      // Per-widget booking window enforcement.
      // Lead time: reject bookings closer than X hours from now (in the sub's TZ).
      // Advance days: reject bookings further than Y days from today (in the sub's TZ).
      // Both NULL = no constraint.
      if (widget && (widget.booking_lead_time_hours != null || widget.booking_advance_days != null)) {
        const tz = require('./lib/timezone');
        const subTz = (blob && blob.settings && blob.settings.timezone) || 'America/New_York';
        const slotMs = tz.apptTimestampInTz(bookingDate, bookingTime, subTz);
        const nowMs  = Date.now();
        const diffHours = (slotMs - nowMs) / 3600000;

        if (widget.booking_lead_time_hours != null) {
          const minHours = parseInt(widget.booking_lead_time_hours) || 0;
          if (minHours > 0 && diffHours < minHours) {
            return res.status(400).json({
              error: `Bookings must be made at least ${minHours} hours in advance.`
            });
          }
        }

        if (widget.booking_advance_days != null) {
          const maxDays = parseInt(widget.booking_advance_days) || 0;
          if (maxDays > 0 && diffHours / 24 > maxDays) {
            return res.status(400).json({
              error: `Bookings can only be made up to ${maxDays} days in advance.`
            });
          }
        }
      }

      const assignedStaff = service && Array.isArray(service.assigned_staff) ? service.assigned_staff : [];

      const staffDbRes = await db.query(
        `SELECT id, username, display_name FROM subaccount_users
         WHERE subaccount_id = $1 AND active = true`,
        [subaccountId]
      );
      allUsers = staffDbRes.rows.map(u => ({
        id: u.id,
        name: u.display_name || u.username
      }));

      if (widgetType === 'service') {
        // Service widget: filter by service.assigned_staff only
        if (assignedStaff.length) {
          allUsers = allUsers.filter(u => assignedStaff.includes(u.id));
        }
      } else if (widgetType === 'appointment') {
        // Appointment widget: filter by widget.staff_ids
        const widgetStaffIds = widget && Array.isArray(widget.staff_ids) ? widget.staff_ids : [];
        if (widgetStaffIds.length) {
          allUsers = allUsers.filter(u => widgetStaffIds.includes(u.id));
        }
      }

      assignedStaffId = (staff_id && staff_id !== 'any') ? staff_id : null;
      // Verify the requested staff is eligible
      if (assignedStaffId && !allUsers.find(u => u.id === assignedStaffId)) {
        return res.status(400).json({ error: 'Selected staff member is not available for this service' });
      }
      // Auto-assign if 'any'.
      //
      // Strategy comes from widget.round_robin_config.strategy:
      //   - 'random' (default): pick a random eligible provider. Distributes
      //     bookings approximately evenly over time without DB queries.
      //   - 'least_busy': pick the provider with the fewest appointments TODAY,
      //     random tiebreaker. Smooths daily load distribution.
      //
      // Eligibility filter: only providers who are NOT already booked at the
      // chosen time. Otherwise we'd pick a busy person and immediately race-fail.
      if (!assignedStaffId) {
        if (!allUsers.length) {
          return res.status(400).json({ error: 'No staff available for this service' });
        }

        // Filter out staff already booked at this exact time (avoid race-fail picks).
        const bookedRes = await db.query(
          `SELECT assigned_to FROM appointments
           WHERE subaccount_id = $1 AND date = $2 AND time = $3 AND status != 'cancelled'`,
          [subaccountId, date, time]
      );
      const bookedAtTime = new Set(bookedRes.rows.map(r => r.assigned_to).filter(Boolean));
      const eligible = allUsers.filter(u => !bookedAtTime.has(u.id));
      if (!eligible.length) {
        return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
      }

      const strategy = (widget && widget.round_robin_config && widget.round_robin_config.strategy) || 'random';

      if (strategy === 'least_busy') {
        // Count today's appointments per eligible provider, pick lowest.
        // Random tiebreaker so we don't always favor the same person at the
        // start of the day when everyone has 0 bookings.
        const eligibleIds = eligible.map(u => u.id);
        const countRes = await db.query(
          `SELECT assigned_to, COUNT(*)::int AS n
           FROM appointments
           WHERE subaccount_id = $1
             AND date = $2
             AND status != 'cancelled'
             AND assigned_to = ANY($3)
           GROUP BY assigned_to`,
          [subaccountId, date, eligibleIds]
        );
        const countMap = {};
        for (const u of eligible) countMap[u.id] = 0;
        for (const r of countRes.rows) countMap[r.assigned_to] = r.n;
        const minCount = Math.min(...eligible.map(u => countMap[u.id]));
        const tied = eligible.filter(u => countMap[u.id] === minCount);
        assignedStaffId = tied[Math.floor(Math.random() * tied.length)].id;
      } else {
        // 'random' (default)
        assignedStaffId = eligible[Math.floor(Math.random() * eligible.length)].id;
      }
    }
    } // end else (non-class) staff resolution block

    // 7. Race condition check (slot still available?)
    // Skipped for class bookings - capacity is enforced inside the transaction
    // when we increment the participants array.
    if (!classSession) {
      const conflictResult = await db.query(
        `SELECT id FROM appointments
         WHERE subaccount_id = $1 AND date = $2 AND assigned_to = $3
           AND time = $4 AND status != 'cancelled' LIMIT 1`,
        [subaccountId, bookingDate, assignedStaffId, bookingTime]
      );
      if (conflictResult.rows.length) {
        return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
      }
    }

    // 8. Coupon validation
    let couponDiscount = 0;
    let couponCode = '';
    let couponId = '';
    let couponObj = null;
    // allow_coupons: when explicitly false on the widget, ignore any submitted coupon code.
    // (Don't error - just silently drop it. The dashboard UI shouldn't show the field
    // when allow_coupons is false, so a coupon arriving here means a determined attempt.)
    const couponsAllowed = !widget || widget.allow_coupons !== false;
    if (couponsAllowed && coupon_code && coupon_code.trim()) {
      const cleanCode = coupon_code.trim().toUpperCase();
      const couponList = blob.coupons || [];
      couponObj = couponList.find(c =>
        c && c.code && c.code.toUpperCase() === cleanCode && c.active !== false
      );
      if (!couponObj) {
        return res.status(400).json({ error: 'Coupon code is not valid' });
      }
      // Check expiration
      if (couponObj.expiresAt && couponObj.expiresAt < date) {
        return res.status(400).json({ error: 'Coupon has expired' });
      }
      // Check usage limit
      if (couponObj.usageLimit && couponObj.usageCount >= couponObj.usageLimit) {
        return res.status(400).json({ error: 'Coupon usage limit reached' });
      }
      // Compute discount
      if (couponObj.discountType === 'pct') {
        couponDiscount = r2(basePrice * (parseFloat(couponObj.discountValue || 0) / 100));
      } else {
        couponDiscount = r2(parseFloat(couponObj.discountValue || 0));
      }
      couponDiscount = Math.min(couponDiscount, basePrice);
      couponCode = couponObj.code;
      couponId = couponObj.id;
    }

    // 8a. require_existing_patient: when true, the email must match an existing contact.
    // Match by lowercased email against contacts blob (matches the Path D contact lookup logic).
    if (widget && widget.require_existing_patient === true) {
      const cleanEmailCheck = (client_info.email || '').toLowerCase().trim();
      const contactsBlobCheck = Array.isArray(blob.contacts) ? blob.contacts : [];
      const matched = contactsBlobCheck.find(c =>
        c && c.email && String(c.email).toLowerCase().trim() === cleanEmailCheck
      );
      if (!matched) {
        return res.status(403).json({
          error: 'Sorry, online booking is currently limited to existing patients. Please contact the office to schedule.'
        });
      }
    }

    // 9. Compute totals per Payment Policy
    // taxableFlag was already set in the lookup branch above.
    const subtotal = r2(basePrice);
    const afterDiscount = r2(Math.max(0, subtotal - couponDiscount));
    const { tax: taxAmount, taxableAmount } = calcTax(subtotal, taxableFlag, couponDiscount, taxSettings);
    const tip = r2(tip_amount || 0);
    const total = r2(afterDiscount + taxAmount + tip);

    // 10. Determine if payment must occur, and how much.
    //
    // require_payment is the on/off toggle. payment_mode controls HOW MUCH:
    //   - 'full'    (default): charge full total
    //   - 'deposit': charge deposit_value or deposit_value% of total, whichever applies
    //   - 'none'   : record a payment row but skip the actual Square charge
    const requirePayment = !!(widget && widget.require_payment);
    const paymentMode    = (widget && widget.payment_mode) || 'full';
    const hasNonceForPayment = !!square_nonce;
    let paymentStatus = 'completed';  // for the payments record
    let paymentMethod = 'none';        // 'card' if Square charge, 'none' if no charge needed
    let paymentId = uid();
    let squarePaymentId = '';
    let cardLast4 = '';
    let cardBrand = '';
    let chargeOccurred = false;

    // Compute the actual amount to charge.
    // depositCharge < total when payment_mode='deposit'; equals total otherwise.
    let chargeAmount = total;
    if (requirePayment && paymentMode === 'deposit' && widget && widget.deposit_value != null) {
      const dv = parseFloat(widget.deposit_value) || 0;
      if (widget.deposit_type === 'percent') {
        chargeAmount = r2(total * dv / 100);
      } else if (widget.deposit_type === 'flat') {
        chargeAmount = Math.min(r2(dv), total);
      }
      if (chargeAmount <= 0) {
        // Misconfigured deposit; fall back to full charge to avoid silent freebies.
        chargeAmount = total;
      }
    }

    if (requirePayment && paymentMode !== 'none' && chargeAmount > 0) {
      if (!hasNonceForPayment) {
        return res.status(400).json({ error: 'Payment information is required for this booking' });
      }

      // Per-subaccount Square creds live in RDS square_credentials, not in the blob.
      // Fetched via lib/square helper (matches POS/charge/etc.).
      const sqCreds = await getSquareCreds(slug);
      if (!sqCreds || !sqCreds.access_token || !sqCreds.location_id) {
        return res.status(500).json({ error: 'Payment processing is not configured. Please contact the business.' });
      }

      const chargeRes = await fetch(`https://${squareHost(sqCreds.sandbox)}/v2/payments`, {
        method: 'POST',
        headers: squareHeaders(sqCreds.access_token),
        body: JSON.stringify({
          source_id:        square_nonce,
          idempotency_key:  paymentId,
          amount_money:     { amount: Math.round(chargeAmount * 100), currency: 'USD' },
          location_id:      sqCreds.location_id,
          note:             `${title} - ${date} ${time}` + (paymentMode === 'deposit' ? ' (deposit)' : ''),
          buyer_email_address: client_info.email
        })
      });
      const chargeData = await chargeRes.json();
      if (!chargeRes.ok || chargeData.errors) {
        const errMsg = chargeData.errors?.[0]?.detail || 'Payment failed. Please check your card details.';
        // No appointment, no contact, no payment record. Per policy, no money state changes.
        return res.status(402).json({ error: errMsg });
      }
      squarePaymentId = chargeData.payment?.id || '';
      cardLast4 = chargeData.payment?.card_details?.card?.last_4 || '';
      cardBrand = chargeData.payment?.card_details?.card?.card_brand || '';
      paymentMethod = 'card';
      chargeOccurred = true;
    }

    // 11. Find or create contact.
    //
    // Note: Path D (contacts blob -> RDS table) hasn't migrated yet. Contacts live in the
    // subaccount_data blob under blob.contacts. When Path D ships, this code will need to
    // switch to writing/reading from the contacts table. For now, blob is the source of truth.
    let contactId;
    const cleanEmail = (client_info.email || '').toLowerCase().trim();
    const contactsBlob = Array.isArray(blob.contacts) ? blob.contacts : [];

    let existing = null;
    if (cleanEmail) {
      existing = contactsBlob.find(c =>
        c && c.email && String(c.email).toLowerCase().trim() === cleanEmail
      );
    }

    if (existing) {
      contactId = existing.id;
    } else {
      contactId = uid();
      contactsBlob.push({
        id: contactId,
        name: client_info.name,
        email: cleanEmail,
        phone: client_info.phone || '',
        createdAt: now_(),
        tags: [],
        source: 'booking_widget'
      });
      const updatedBlob = { ...blob, contacts: contactsBlob };
      await db.query(
        'UPDATE subaccount_data SET data = $1 WHERE subaccount_id = $2',
        [JSON.stringify(updatedBlob), subaccountId]
      );
    }

    // 12. Create the booking record.
    //
    // For service and appointment widgets: insert into appointments table.
    // For class widgets: append the participant to the JSONB array using a
    // conditional UPDATE that ALSO checks capacity in the same SQL statement.
    // PostgreSQL's row-level write atomicity guarantees no two concurrent
    // registrations can both consume the last spot.
    let apptId = null;            // null for class bookings
    let participantId = null;     // null for service/appointment bookings

    if (classSession) {
      participantId = uid();
      // Match the existing participant schema used by svcEnroll and the dashboard
      // roster: {contact_id, status, enrolled_at}. Adding extra fields (id, source)
      // is fine - existing code ignores unknown keys.
      const newParticipant = {
        id: participantId,
        contact_id: contactId,
        status: 'enrolled',
        enrolled_at: now_(),
        source: 'booking_widget',
        widget_id: widget_id || null
      };
      // Conditional UPDATE: only succeeds if session is scheduled AND capacity available.
      // The WHERE clause counts current 'enrolled' participants and compares to capacity
      // in the same statement that appends, making the check + write atomic.
      const updateRes = await db.query(
        `UPDATE class_sessions
         SET participants = COALESCE(participants, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2
           AND subaccount_id = $3
           AND status = 'scheduled'
           AND (
             SELECT COUNT(*)
             FROM jsonb_array_elements(COALESCE(participants, '[]'::jsonb)) AS p
             WHERE p->>'status' = 'enrolled'
           ) < capacity
         RETURNING id`,
        [JSON.stringify(newParticipant), classSession.id, subaccountId]
      );
      if (!updateRes.rows.length) {
        // Either cancelled or full. Re-read to give the user a useful error.
        const checkRes = await db.query(
          `SELECT status, capacity, participants FROM class_sessions
           WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
          [classSession.id, subaccountId]
        );
        if (!checkRes.rows.length) {
          return res.status(404).json({ error: 'Class session not found' });
        }
        const row = checkRes.rows[0];
        if (row.status === 'cancelled') {
          return res.status(400).json({ error: 'This class session has been cancelled' });
        }
        return res.status(409).json({ error: 'This class is full. Please pick another session.' });
      }
    } else {
      // Service or appointment widget: standard appointment INSERT
      apptId = uid();
      const apptLocation = service ? (service.location || null) : null;
      const apptServiceId = service ? service_id : null; // null for appointment widgets
      const apptVariationId = service ? (variation_id || null) : null;
      // Per-appointment price + type_id when this is an appointment widget.
      // For service widgets, price is derived from the service/variation in the dashboard.
      // For appointment widgets, price/type live on the row itself.
      const apptPrice = appointmentType
        ? (appointmentType.price != null ? parseFloat(appointmentType.price) : null)
        : null;
      const apptTypeId = appointmentType ? (appointmentType.id || null) : null;
      // Honor widget.collect_notes: if false, don't store any submitted notes.
      const apptNotes = (widget && widget.collect_notes === false)
        ? null
        : (client_info.notes || null);
      await db.query(`
        INSERT INTO appointments (
          id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
          status, location, notes, service_id, service_variation_id, buffer_before, buffer_after,
          booked_via, widget_id, price, appointment_type_id,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
      `, [
        apptId, subaccountId, title, contactId, assignedStaffId,
        bookingDate, bookingTime, duration,
        apptLocation, apptNotes,
        apptServiceId, apptVariationId, bufBefore, bufAfter,
        'widget', widget_id || null, apptPrice, apptTypeId
      ]);
    }

    // 13. Create payment record - only when actual money changed hands.
    // Bookings with payment_mode='none' or free services don't create payment
    // records: no money in/out means nothing for the payments ledger to track.
    // The appointment row alone records the booking; staff takes payment via
    // the dashboard if and when collected.
    //
    // For payment_mode='deposit': the record reflects ONLY the deposit transaction
    // (subtotal/total = chargeAmount, tax=0). The remaining balance is collected
    // at the visit and creates a SECOND payment record at that time.
    if (chargeOccurred) {
      const isDeposit = paymentMode === 'deposit' && chargeAmount < total;

      const pmtSubtotal       = isDeposit ? chargeAmount : subtotal;
      const pmtAfterDiscount  = isDeposit ? chargeAmount : afterDiscount;
      const pmtTax            = isDeposit ? 0 : taxAmount;
      const pmtTaxable        = isDeposit ? 0 : taxableAmount;
      const pmtCouponDiscount = isDeposit ? 0 : couponDiscount;
      const pmtTip            = isDeposit ? 0 : tip;
      const pmtTotal          = isDeposit ? chargeAmount : total;
      const pmtNotes = isDeposit
        ? `Deposit for ${title} - full price $${total.toFixed(2)}` + (widget ? ` (widget: ${widget.name})` : '')
        : 'Booked via widget' + (widget ? ` (${widget.name})` : '');

      // Real payment record - charge happened OR payment was required (total > 0)
      const pmt = {
        id: paymentId,
        subaccount_id: subaccountId,
        contact_id: contactId,
        staff_id: assignedStaffId,
        items: JSON.stringify([{
          desc: title,
          price: pmtSubtotal,
          taxable: isDeposit ? false : taxableFlag
        }]),
        subtotal: pmtSubtotal,
        coupon_discount: pmtCouponDiscount,
        coupon_code: isDeposit ? '' : couponCode,
        coupon_id: isDeposit ? '' : couponId,
        discount_amount: 0,
        after_discount: pmtAfterDiscount,
        fee_amount: 0,
        tax_amount: pmtTax,
        taxable_amount: pmtTaxable,
        tip_amount: pmtTip,
        credit_applied: 0,
        total: pmtTotal,
        payment_method: paymentMethod,
        card_last4: cardLast4,
        card_brand: cardBrand,
        square_payment_id: squarePaymentId,
        status: 'completed',
        notes: pmtNotes,
        appointment_id: apptId,                // null for class bookings
        class_session_id: classSession ? classSession.id : null,
        participant_contact_id: classSession ? contactId : null
      };
      await db.query(`
        INSERT INTO payments (
          id, subaccount_id, contact_id, staff_id, items,
          subtotal, coupon_discount, coupon_code, coupon_id,
          discount_amount, after_discount, fee_amount, tax_amount, taxable_amount,
          tip_amount, credit_applied, total,
          payment_method, card_last4, card_brand, square_payment_id,
          status, notes, appointment_id, class_session_id, participant_contact_id,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb,
          $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, $25, $26,
          NOW(), NOW()
        )
      `, [
        pmt.id, pmt.subaccount_id, pmt.contact_id, pmt.staff_id, pmt.items,
        pmt.subtotal, pmt.coupon_discount, pmt.coupon_code, pmt.coupon_id,
        pmt.discount_amount, pmt.after_discount, pmt.fee_amount, pmt.tax_amount, pmt.taxable_amount,
        pmt.tip_amount, pmt.credit_applied, pmt.total,
        pmt.payment_method, pmt.card_last4, pmt.card_brand, pmt.square_payment_id,
        pmt.status, pmt.notes, pmt.appointment_id, pmt.class_session_id, pmt.participant_contact_id
      ]);
    }

    // 14. Log coupon usage (only after payment succeeded - per policy, never on failure)
    if (couponObj && (chargeOccurred || !requirePayment)) {
      const cpnList = blob.coupons || [];
      const cpnIdx = cpnList.findIndex(c => c.id === couponObj.id);
      if (cpnIdx >= 0) {
        const cpn = cpnList[cpnIdx];
        cpn.usageCount = (cpn.usageCount || 0) + 1;
        cpn.usageLog = cpn.usageLog || [];
        cpn.usageLog.push({
          id: uid(),
          contactId: contactId,
          paymentId: paymentId,
          amountSaved: couponDiscount,
          date: now_(),
          staffId: assignedStaffId
        });
        cpnList[cpnIdx] = cpn;
        const updatedBlob = { ...blob, coupons: cpnList };
        await db.query(
          'UPDATE subaccount_data SET data = $1 WHERE subaccount_id = $2',
          [JSON.stringify(updatedBlob), subaccountId]
        );
      }
    }

    // 15. Increment widget analytics counter (best effort, don't fail booking).
    if (widget_id) {
      try {
        await db.query(
          'UPDATE service_widgets SET total_bookings = total_bookings + 1, updated_at = NOW() WHERE id = $1 AND subaccount_id = $2',
          [widget_id, subaccountId]
        );
      } catch (e) {
        console.error('total_bookings increment failed:', e.message);
      }
    }

    // 16. Audit log
    await logAudit({
      req,
      actorType: 'public',
      actorId: contactId,
      actorUsername: client_info.email,
      actorRole: 'client',
      action: classSession ? 'booking.class.register' : 'booking.appointment.create',
      targetType: classSession ? 'class_participant' : 'appointment',
      targetId: classSession ? participantId : apptId,
      targetSubaccountId: subaccountId,
      metadata: {
        service_id: service_id || (classSession ? classSession.service_id : null),
        appointment_type_id: appointment_type_id || null,
        class_session_id: class_session_id || null,
        widget_type: widgetType,
        date: bookingDate,
        time: bookingTime,
        widget_id: widget_id || null,
        payment_status: chargeOccurred ? 'charged' : 'no_charge',
        total: total,
        coupon_used: !!couponObj,
        via: 'booking_widget'
      }
    });

    // 16. Confirmation email (don't fail the booking if email fails)
    // Per-widget send_confirmation_email overrides global bookingSettings.send_confirmation_email.
    // Default: send. Either setting being explicitly false suppresses.
    const emailGate = (widget && widget.send_confirmation_email === false)
      ? false
      : (bs.send_confirmation_email !== false);
    if (emailGate) {
      const bizName = settings.businessName || slug;
      const staffUser = allUsers.find(u => u.id === assignedStaffId) || null;
      const staffLabel = classSession ? 'Instructor' : 'Provider';
      const staffName = staffUser ? staffUser.name : (classSession ? 'TBD' : 'your provider');
      const headline = classSession ? 'Class Registration Confirmed' : 'Appointment Confirmed';
      const subject = bs.confirmation_subject || `${headline} - ${bizName}`;
      const customMsg = (widget && widget.confirm_message) || bs.confirmation_message || '';

      const html = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin-bottom:4px;color:#1a1030">${headline}</h2>
          <p style="color:#6b7280;margin-top:0">${bizName}</p>
          <div style="background:#f9f7ff;border-radius:8px;padding:20px;margin:20px 0">
            <div style="margin-bottom:8px"><strong>${classSession ? 'Class' : 'Service'}:</strong> ${title}</div>
            <div style="margin-bottom:8px"><strong>Date:</strong> ${bookingDate}</div>
            <div style="margin-bottom:8px"><strong>Time:</strong> ${fmtTime(bookingTime)}${settings.timezone ? ' ' + tzLabel(settings.timezone) : ''}</div>
            <div style="margin-bottom:8px"><strong>${staffLabel}:</strong> ${staffName}</div>
            ${chargeOccurred ? `
              <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e0ff">
                <div style="margin-bottom:4px"><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</div>
                ${couponDiscount > 0 ? `<div style="margin-bottom:4px;color:#10b981"><strong>Coupon (${couponCode}):</strong> -$${couponDiscount.toFixed(2)}</div>` : ''}
                ${taxAmount > 0 ? `<div style="margin-bottom:4px"><strong>${taxSettings.label || 'Tax'}:</strong> $${taxAmount.toFixed(2)}</div>` : ''}
                ${tip > 0 ? `<div style="margin-bottom:4px"><strong>Tip:</strong> $${tip.toFixed(2)}</div>` : ''}
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e0ff;font-size:15px"><strong>Total Charged:</strong> $${total.toFixed(2)}</div>
                ${cardLast4 ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${cardBrand || 'Card'} ending in ${cardLast4}</div>` : ''}
              </div>
            ` : (basePrice > 0 ? `<div style="margin-top:8px"><strong>Price:</strong> $${basePrice.toFixed(2)} (to be paid at ${classSession ? 'class' : 'appointment'})</div>` : '')}
          </div>
          ${customMsg ? `<p>${customMsg}</p>` : ''}
          ${bs.cancellation_policy_text ? `<p style="font-size:12px;color:#6b7280"><strong>Cancellation policy:</strong> ${bs.cancellation_policy_text}</p>` : ''}
          <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:16px">Powered by MySpark+</p>
        </div>`;

      // Don't await; let it run async so a slow email doesn't block the booking response
      sendConfirmationEmail(slug, client_info.email, subject, html, bizName, contactId);
    }

    return res.status(200).json({
      success: true,
      appointment_id: apptId,                   // null for class bookings
      class_session_id: classSession ? classSession.id : null,
      participant_id: participantId,            // null for service/appointment
      staff_id: assignedStaffId,
      payment: chargeOccurred ? {
        total: total,
        subtotal: subtotal,
        tax: taxAmount,
        tip: tip,
        coupon_discount: couponDiscount,
        card_last4: cardLast4,
        card_brand: cardBrand
      } : null,
      confirm_message: (widget && widget.confirm_message) || null,
      message: classSession
        ? 'You are registered for the class. Check your email for confirmation.'
        : 'Your appointment has been booked. Check your email for confirmation.'
    });

  } catch (e) {
    console.error('booking-submit error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }
}

exports.handler = wrap(handler);
