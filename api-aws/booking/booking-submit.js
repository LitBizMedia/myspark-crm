// api/booking/booking-submit.js
// POST /api/booking/submit
// PUBLIC - no auth required
// Creates an appointment from a public booking widget

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

const resend = require('./lib/resend');

async function sendConfirmationEmail(slug, to, subject, html, bizName, contactId) {
  try {
    const result = await resend.sendEmail(slug, {
      to,
      subject,
      html,
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

  const { slug, service_id, variation_id, staff_id, date, time, client_info, square_nonce, tip_amount } = body;

  if (!slug || !service_id || !date || !time)
    return res.status(400).json({ error: 'slug, service_id, date, and time are required' });
  if (!client_info?.name || !client_info?.email)
    return res.status(400).json({ error: 'Client name and email are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });
  if (!/^\d{2}:\d{2}$/.test(time))
    return res.status(400).json({ error: 'Invalid time format' });

  try {
    // 1. Subaccount lookup
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1', [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Service
    const svcResult = await db.query(
      'SELECT * FROM services WHERE id = $1 AND subaccount_id = $2 AND active = true LIMIT 1',
      [service_id, subaccountId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });
    const service = svcResult.rows[0];

    // 3. Variation overrides
    let duration  = service.duration_default || 60;
    let bufBefore = service.buffer_before    || 0;
    let bufAfter  = service.buffer_after     || 0;
    let price     = service.price;
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
        price     = v.price         != null ? v.price         : price;
        varName   = v.name || '';
      }
    }

    // 4. Blob
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1', [subaccountId]
    );
    const blob     = blobResult.rows[0]?.data || {};
    const settings = blob.settings || {};
    const bs       = settings.bookingSettings || {};

    // 5. Resolve staff from subaccount_users (single source of truth)
    const assignedStaff = Array.isArray(service.assigned_staff) ? service.assigned_staff : [];
    const staffDbRes = await db.query(
      `SELECT id, username, display_name 
       FROM subaccount_users 
       WHERE subaccount_id = $1 AND active = true`,
      [subaccountId]
    );
    const allUsers = staffDbRes.rows.map(u => ({
      id: u.id,
      name: u.display_name || u.username
    }));
    let assignedStaffId = (staff_id && staff_id !== 'any') ? staff_id : null;
    if (!assignedStaffId) {
      const eligible = allUsers.filter(u =>
        !assignedStaff.length || assignedStaff.includes(u.id)
      );
      if (eligible.length) assignedStaffId = eligible[0].id;
    }

    // 6. Race condition check
    if (assignedStaffId && time) {
      const conflictResult = await db.query(
        `SELECT id FROM appointments
         WHERE subaccount_id = $1 AND date = $2 AND assigned_to = $3
         AND time = $4 AND status != 'cancelled' LIMIT 1`,
        [subaccountId, date, assignedStaffId, time]
      );
      if (conflictResult.rows.length) {
        return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
      }
    }

    // 7. Square payment (if required and nonce provided)
    let paymentStatus = 'none';
    let paymentId = null;
    const paymentMode = bs.default_payment_mode || 'none';

    if (paymentMode !== 'none' && square_nonce) {
      const squareSettings = settings.square || {};
      if (!squareSettings.accessToken || !squareSettings.locationId) {
        return res.status(400).json({ error: 'Payment required but Square is not configured for this account' });
      }

      // Calculate charge
      let chargeUSD = 0;
      if (paymentMode === 'full' && price != null) {
        chargeUSD = parseFloat(price);
      } else if (paymentMode === 'deposit') {
        const depType = bs.deposit_type || 'percent';
        const depVal  = parseFloat(bs.deposit_value) || 25;
        chargeUSD = depType === 'percent' && price != null
          ? parseFloat(price) * depVal / 100
          : depVal;
      }
      chargeUSD += tip_amount ? parseFloat(tip_amount) : 0;

      if (chargeUSD > 0) {
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
            idempotency_key:  uid(),
            amount_money:     { amount: Math.round(chargeUSD * 100), currency: 'USD' },
            location_id:      squareSettings.locationId,
            note:             `${service.name} - ${date} ${time}`,
            buyer_email_address: client_info.email
          })
        });
        const chargeData = await chargeRes.json();
        if (!chargeRes.ok || chargeData.errors) {
          const errMsg = chargeData.errors?.[0]?.detail || 'Payment failed. Please check your card details.';
          return res.status(402).json({ error: errMsg });
        }
        paymentStatus = 'paid';
        paymentId = chargeData.payment?.id || null;
      }
    }

    // 8. Find or create contact in blob
    const contacts = blob.contacts || [];
    let contact = contacts.find(c => c.email && c.email.toLowerCase() === client_info.email.toLowerCase());
    let contactId;
    if (contact) {
      contactId = contact.id;
    } else {
      contactId = uid();
      contacts.push({
        id: contactId, name: client_info.name, email: client_info.email,
        phone: client_info.phone || '', createdAt: new Date().toISOString(),
        tags: [], source: 'booking_widget'
      });
    }

    // 9. Build appointment object
    const apptId = uid();
    const title  = service.name + (varName ? ` - ${varName}` : '');
    const apptForBlob = {
      id: apptId, contactId, assignedTo: assignedStaffId,
      title, date, time, duration, status: 'scheduled',
      location: service.location || null,
      notes: client_info.notes || null,
      service_id, variation_id: variation_id || null,
      buffer_before: bufBefore, buffer_after: bufAfter,
      bookedVia: 'widget', createdAt: new Date().toISOString()
    };

    // 10. Insert into appointments table
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

    // 11. Update blob (add appointment + contact)
    const updatedBlob = {
      ...blob,
      contacts,
      appointments: [...(blob.appointments || []), apptForBlob]
    };
    await db.query(
      'UPDATE subaccount_data SET data = $1 WHERE subaccount_id = $2',
      [JSON.stringify(updatedBlob), subaccountId]
    );

    // 12. Confirmation email
    if (bs.send_confirmation_email !== false) {
      const bizName   = settings.businessName || slug;
      const staffUser = allUsers.find(u => u.id === assignedStaffId) || null;
      const staffName = staffUser ? (staffUser.name || staffUser.username) : 'your provider';
      const subject   = bs.confirmation_subject || `Appointment Confirmed - ${bizName}`;
      const html = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin-bottom:4px;color:#1a1030">Appointment Confirmed</h2>
          <p style="color:#6b7280;margin-top:0">${bizName}</p>
          <div style="background:#f9f7ff;border-radius:8px;padding:20px;margin:20px 0">
            <div style="margin-bottom:8px"><strong>Service:</strong> ${title}</div>
            <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
            <div style="margin-bottom:8px"><strong>Time:</strong> ${fmtTime(time)}</div>
            <div style="margin-bottom:8px"><strong>Provider:</strong> ${staffName}</div>
            ${price != null ? `<div><strong>Price:</strong> $${parseFloat(price).toFixed(2)}</div>` : ''}
          </div>
          ${bs.confirmation_message ? `<p>${bs.confirmation_message}</p>` : ''}
          ${bs.cancellation_policy_text ? `<p style="font-size:12px;color:#6b7280"><strong>Cancellation policy:</strong> ${bs.cancellation_policy_text}</p>` : ''}
          <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:16px">Powered by MySpark+</p>
        </div>`;
      await sendConfirmationEmail(slug, client_info.email, subject, html, settings.businessName || slug, contactId);
    }

    // 13. Audit log
    await logAudit({
      req, actorType:'public', actorId:contactId,
      actorUsername: client_info.email, actorRole:'client',
      action:'booking.appointment.create',
      targetType:'appointment', targetId:apptId,
      targetSubaccountId:subaccountId,
      metadata:{ service_id, date, time, payment_status:paymentStatus, via:'booking_widget' }
    });

    return res.status(200).json({
      success: true,
      appointment_id: apptId,
      message: 'Your appointment has been booked. Check your email for confirmation.'
    });

  } catch (e) {
    console.error('booking-submit error:', e.message);
    return res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }
}

exports.handler = wrap(handler);
