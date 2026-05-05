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

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const now_ = () => new Date().toISOString();

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
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
    staff_id,
    date,
    time,
    client_info,
    square_nonce,
    coupon_code,
    tip_amount
  } = body;

  // Input validation
  if (!slug || !service_id || !date || !time)
    return res.status(400).json({ error: 'slug, service_id, date, and time are required' });
  if (!client_info?.name || !client_info?.email)
    return res.status(400).json({ error: 'Client name and email are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });
  if (!/^\d{2}:\d{2}$/.test(time))
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
        `SELECT id, name, service_ids, staff_mode, staff_ids, require_payment, confirm_message
         FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = TRUE LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wResult.rows.length) {
        return res.status(404).json({ error: 'Widget not found or inactive' });
      }
      widget = wResult.rows[0];

      // Verify the service is allowed by this widget
      if (Array.isArray(widget.service_ids) && widget.service_ids.length &&
          !widget.service_ids.includes(service_id)) {
        return res.status(400).json({ error: 'Service not available on this widget' });
      }
    }

    // 3. Service lookup
    const svcResult = await db.query(
      'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1',
      [service_id, subaccountId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });
    const service = svcResult.rows[0];

    // 4. Variation overrides
    let duration  = service.duration_default || 60;
    let bufBefore = service.buffer_before    || 0;
    let bufAfter  = service.buffer_after     || 0;
    let basePrice = service.price != null ? parseFloat(service.price) : 0;
    let varName   = '';

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

    // 5. Read settings (for tax, square, confirmation email)
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const bs       = settings.bookingSettings || {};
    const paySettings = settings.paySettings || {};
    const taxSettings = paySettings.tax || bs.tax || { enabled: false, rate: 0, label: 'Sales Tax' };

    // 6. Resolve assigned staff (eligible pool)
    const assignedStaff = Array.isArray(service.assigned_staff) ? service.assigned_staff : [];
    const widgetStaffIds = widget && Array.isArray(widget.staff_ids) ? widget.staff_ids : [];
    const staffMode = widget && widget.staff_mode || 'any';

    const staffDbRes = await db.query(
      `SELECT id, username, display_name FROM subaccount_users
       WHERE subaccount_id = $1 AND active = true`,
      [subaccountId]
    );
    let allUsers = staffDbRes.rows.map(u => ({
      id: u.id,
      name: u.display_name || u.username
    }));

    // Apply widget filtering
    if ((staffMode === 'specific' || staffMode === 'round_robin') && widgetStaffIds.length) {
      allUsers = allUsers.filter(u => widgetStaffIds.includes(u.id));
    }
    // Apply service filtering
    if (assignedStaff.length) {
      allUsers = allUsers.filter(u => assignedStaff.includes(u.id));
    }

    let assignedStaffId = (staff_id && staff_id !== 'any') ? staff_id : null;
    // Verify the requested staff is eligible
    if (assignedStaffId && !allUsers.find(u => u.id === assignedStaffId)) {
      return res.status(400).json({ error: 'Selected staff member is not available for this service' });
    }
    // Auto-assign if 'any' (Stage 1: alphabetical first; Stage 4 will use weighted round robin)
    if (!assignedStaffId) {
      if (!allUsers.length) {
        return res.status(400).json({ error: 'No staff available for this service' });
      }
      // For now: first alphabetical. Stage 4 will use round_robin_config.
      const sorted = [...allUsers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      assignedStaffId = sorted[0].id;
    }

    // 7. Race condition check (slot still available?)
    const conflictResult = await db.query(
      `SELECT id FROM appointments
       WHERE subaccount_id = $1 AND date = $2 AND assigned_to = $3
         AND time = $4 AND status != 'cancelled' LIMIT 1`,
      [subaccountId, date, assignedStaffId, time]
    );
    if (conflictResult.rows.length) {
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
    }

    // 8. Coupon validation
    let couponDiscount = 0;
    let couponCode = '';
    let couponId = '';
    let couponObj = null;
    if (coupon_code && coupon_code.trim()) {
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

    // 9. Compute totals per Payment Policy
    const subtotal = r2(basePrice);
    const afterDiscount = r2(Math.max(0, subtotal - couponDiscount));
    const taxableFlag = service.taxable !== false;
    const { tax: taxAmount, taxableAmount } = calcTax(subtotal, taxableFlag, couponDiscount, taxSettings);
    const tip = r2(tip_amount || 0);
    const total = r2(afterDiscount + taxAmount + tip);

    // 10. Determine if payment must occur
    const requirePayment = !!(widget && widget.require_payment);
    const hasNonceForPayment = !!square_nonce;
    let paymentStatus = 'completed';  // for the payments record
    let paymentMethod = 'none';        // 'card' if Square charge, 'none' if no charge needed
    let paymentId = uid();
    let squarePaymentId = '';
    let cardLast4 = '';
    let cardBrand = '';
    let chargeOccurred = false;

    if (requirePayment && total > 0) {
      if (!hasNonceForPayment) {
        return res.status(400).json({ error: 'Payment information is required for this booking' });
      }

      const squareSettings = settings.square || {};
      if (!squareSettings.accessToken || !squareSettings.locationId) {
        return res.status(500).json({ error: 'Payment processing is not configured. Please contact the business.' });
      }

      const squareBase = squareSettings.sandbox
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';

      const chargeRes = await fetch(`${squareBase}/v2/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${squareSettings.accessToken}`
        },
        body: JSON.stringify({
          source_id:        square_nonce,
          idempotency_key:  paymentId,
          amount_money:     { amount: Math.round(total * 100), currency: 'USD' },
          location_id:      squareSettings.locationId,
          note:             `${service.name}${varName ? ' - ' + varName : ''} - ${date} ${time}`,
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

    // 11. Find or create contact in contacts table (NOT blob)
    let contact = null;
    let contactId;
    const cleanEmail = (client_info.email || '').toLowerCase().trim();
    if (cleanEmail) {
      const cRes = await db.query(
        `SELECT id FROM contacts WHERE subaccount_id = $1 AND LOWER(email) = $2 LIMIT 1`,
        [subaccountId, cleanEmail]
      );
      if (cRes.rows.length) contact = cRes.rows[0];
    }
    if (contact) {
      contactId = contact.id;
    } else {
      contactId = uid();
      // Stage 4 backlog: contacts table currently exists but contacts may also live in blob
      // depending on migration state. For now, write to whichever path exists.
      try {
        await db.query(
          `INSERT INTO contacts (id, subaccount_id, name, email, phone, source, tags, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'booking_widget', '[]'::jsonb, NOW(), NOW())`,
          [contactId, subaccountId, client_info.name, cleanEmail, client_info.phone || '']
        );
      } catch (e) {
        // Fallback: write to blob if contacts table doesn't exist or insert fails for other reason
        console.warn('Contacts table insert failed, falling back to blob:', e.message);
        const contactsBlob = blob.contacts || [];
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
    }

    // 12. Create appointment in appointments table (NOT blob)
    const apptId = uid();
    const title  = service.name + (varName ? ` - ${varName}` : '');
    await db.query(`
      INSERT INTO appointments (
        id, subaccount_id, title, contact_id, assigned_to, date, time, duration,
        status, location, notes, service_id, variation_id, buffer_before, buffer_after,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12,$13,$14,NOW(),NOW())
    `, [
      apptId, subaccountId, title, contactId, assignedStaffId,
      date, time, duration,
      service.location || null, client_info.notes || null,
      service_id, variation_id || null, bufBefore, bufAfter
    ]);

    // 13. Create payment record (always, even if total=0 with no Square charge - records the booking)
    // Per Payment Policy: every booking through the widget creates a payment record.
    // If no charge occurred (e.g. pay-at-visit), method='none' and total may be 0 or service price.
    if (chargeOccurred || requirePayment) {
      // Real payment record - charge happened OR payment was required (total > 0)
      const pmt = {
        id: paymentId,
        subaccount_id: subaccountId,
        contact_id: contactId,
        staff_id: assignedStaffId,
        items: JSON.stringify([{
          desc: title,
          price: subtotal,
          taxable: taxableFlag
        }]),
        subtotal: subtotal,
        coupon_discount: couponDiscount,
        coupon_code: couponCode,
        coupon_id: couponId,
        discount_amount: 0,
        after_discount: afterDiscount,
        fee_amount: 0,
        tax_amount: taxAmount,
        taxable_amount: taxableAmount,
        tip_amount: tip,
        credit_applied: 0,
        total: total,
        payment_method: paymentMethod,
        card_last4: cardLast4,
        card_brand: cardBrand,
        square_payment_id: squarePaymentId,
        status: 'completed',
        notes: 'Booked via widget' + (widget ? ` (${widget.name})` : ''),
        appointment_id: apptId
      };
      await db.query(`
        INSERT INTO payments (
          id, subaccount_id, contact_id, staff_id, items,
          subtotal, coupon_discount, coupon_code, coupon_id,
          discount_amount, after_discount, fee_amount, tax_amount, taxable_amount,
          tip_amount, credit_applied, total,
          payment_method, card_last4, card_brand, square_payment_id,
          status, notes, appointment_id, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb,
          $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, NOW(), NOW()
        )
      `, [
        pmt.id, pmt.subaccount_id, pmt.contact_id, pmt.staff_id, pmt.items,
        pmt.subtotal, pmt.coupon_discount, pmt.coupon_code, pmt.coupon_id,
        pmt.discount_amount, pmt.after_discount, pmt.fee_amount, pmt.tax_amount, pmt.taxable_amount,
        pmt.tip_amount, pmt.credit_applied, pmt.total,
        pmt.payment_method, pmt.card_last4, pmt.card_brand, pmt.square_payment_id,
        pmt.status, pmt.notes, pmt.appointment_id
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

    // 15. Audit log
    await logAudit({
      req,
      actorType: 'public',
      actorId: contactId,
      actorUsername: client_info.email,
      actorRole: 'client',
      action: 'booking.appointment.create',
      targetType: 'appointment',
      targetId: apptId,
      targetSubaccountId: subaccountId,
      metadata: {
        service_id,
        date,
        time,
        widget_id: widget_id || null,
        payment_status: chargeOccurred ? 'charged' : 'no_charge',
        total: total,
        coupon_used: !!couponObj,
        via: 'booking_widget'
      }
    });

    // 16. Confirmation email (don't fail the booking if email fails)
    if (bs.send_confirmation_email !== false) {
      const bizName = settings.businessName || slug;
      const staffUser = allUsers.find(u => u.id === assignedStaffId) || null;
      const staffName = staffUser ? staffUser.name : 'your provider';
      const subject = bs.confirmation_subject || `Appointment Confirmed - ${bizName}`;
      const customMsg = (widget && widget.confirm_message) || bs.confirmation_message || '';

      const html = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin-bottom:4px;color:#1a1030">Appointment Confirmed</h2>
          <p style="color:#6b7280;margin-top:0">${bizName}</p>
          <div style="background:#f9f7ff;border-radius:8px;padding:20px;margin:20px 0">
            <div style="margin-bottom:8px"><strong>Service:</strong> ${title}</div>
            <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
            <div style="margin-bottom:8px"><strong>Time:</strong> ${fmtTime(time)}</div>
            <div style="margin-bottom:8px"><strong>Provider:</strong> ${staffName}</div>
            ${chargeOccurred ? `
              <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e0ff">
                <div style="margin-bottom:4px"><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</div>
                ${couponDiscount > 0 ? `<div style="margin-bottom:4px;color:#10b981"><strong>Coupon (${couponCode}):</strong> -$${couponDiscount.toFixed(2)}</div>` : ''}
                ${taxAmount > 0 ? `<div style="margin-bottom:4px"><strong>${taxSettings.label || 'Tax'}:</strong> $${taxAmount.toFixed(2)}</div>` : ''}
                ${tip > 0 ? `<div style="margin-bottom:4px"><strong>Tip:</strong> $${tip.toFixed(2)}</div>` : ''}
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e0ff;font-size:15px"><strong>Total Charged:</strong> $${total.toFixed(2)}</div>
                ${cardLast4 ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${cardBrand || 'Card'} ending in ${cardLast4}</div>` : ''}
              </div>
            ` : (basePrice > 0 ? `<div style="margin-top:8px"><strong>Price:</strong> $${basePrice.toFixed(2)} (to be paid at appointment)</div>` : '')}
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
      appointment_id: apptId,
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
      message: 'Your appointment has been booked. Check your email for confirmation.'
    });

  } catch (e) {
    console.error('booking-submit error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }
}

exports.handler = wrap(handler);
