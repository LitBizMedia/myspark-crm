// api/booking/booking-widget-data.js
// GET /api/booking/widget-data?slug=SLUG&widget_id=WIDGET_ID
// PUBLIC - no auth required
// Returns all data the booking widget needs to render
//
// CHANGED 2026-05-05: widget config now read from service_widgets RDS table,
// not from blob.serviceWidgets. Includes new fields: staff_mode, staff_ids,
// require_payment, intake_form_id, confirm_message.
//
// CHANGED 2026-05-07: TZ-aware. Class session 30-day horizon now computed in
// the subaccount's timezone, not UTC.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { todayInTz, dateInTzPlusDays } = require('./lib/timezone');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, widget_id } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  // Basic input validation
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
    return res.status(400).json({ error: 'invalid slug format' });
  }
  if (widget_id && !/^[a-z0-9-]{1,64}$/i.test(widget_id)) {
    return res.status(400).json({ error: 'invalid widget id format' });
  }

  try {
    // 1. Look up subaccount
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1',
      [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Look up widget from service_widgets table (RDS, single source of truth post Path A)
    let widget = null;
    if (widget_id) {
      const wResult = await db.query(
        `SELECT id, name, widget_type, service_ids, primary_color, logo_url, tagline, active,
                staff_mode, staff_ids, round_robin_config, appointment_types, widget_availability, require_payment,
                intake_form_id, confirm_message,
                payment_mode, deposit_type, deposit_value,
                allow_coupons, allow_tip, tip_percentages,
                collect_phone, collect_notes, require_existing_patient,
                allow_self_cancel, cancel_window_hours,
                send_confirmation_email, send_reminder_email, reminder_hours_before, send_reminder_sms,
                booking_lead_time_hours, booking_advance_days,
                buffer_before_override, buffer_after_override,
                total_views, total_bookings, custom_domain, slot_interval_minutes
         FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = TRUE
         LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wResult.rows.length) {
        return res.status(404).json({ error: 'Widget not found or inactive' });
      }
      widget = wResult.rows[0];

      // Increment total_views counter. Best effort, swallow errors so analytics
      // bookkeeping can never break a public page load. Refreshes count; bots
      // may inflate. Deduplication and IP rate limiting are future work.
      try {
        await db.query(
          'UPDATE service_widgets SET total_views = total_views + 1 WHERE id = $1 AND subaccount_id = $2',
          [widget_id, subaccountId]
        );
      } catch (e) {
        console.error('total_views increment failed:', e.message);
      }
    } else {
      const wResult = await db.query(
        `SELECT id, name, widget_type, service_ids, primary_color, logo_url, tagline, active,
                staff_mode, staff_ids, round_robin_config, appointment_types, widget_availability, require_payment,
                intake_form_id, confirm_message,
                payment_mode, deposit_type, deposit_value,
                allow_coupons, allow_tip, tip_percentages,
                collect_phone, collect_notes, require_existing_patient,
                allow_self_cancel, cancel_window_hours,
                send_confirmation_email, send_reminder_email, reminder_hours_before, send_reminder_sms,
                booking_lead_time_hours, booking_advance_days,
                buffer_before_override, buffer_after_override,
                total_views, total_bookings, custom_domain, slot_interval_minutes
         FROM service_widgets
         WHERE subaccount_id = $1 AND active = TRUE
         ORDER BY created_at ASC
         LIMIT 1`,
        [subaccountId]
      );
      widget = wResult.rows[0] || null;
    }

    // 3. Get blob for non-widget settings
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
      [subaccountId]
    );
    const blob = blobResult.rows[0]?.data || {};
    const subTz = (blob.settings && blob.settings.timezone) || 'America/Chicago';

    // 4. Get active services
    const widgetType = (widget && widget.widget_type) || 'service';
    const widgetServiceIds = widget && Array.isArray(widget.service_ids) ? widget.service_ids : [];
    let svcQuery, svcArgs, skipServiceQuery = false;
    if (widgetType === 'appointment') {
      skipServiceQuery = true;
    } else if (widgetType === 'class') {
      if (widgetServiceIds.length) {
        svcQuery = `SELECT * FROM services
                    WHERE subaccount_id = $1 AND active = true
                      AND type = 'class'
                      AND id = ANY($2::text[])
                    ORDER BY name ASC`;
        svcArgs = [subaccountId, widgetServiceIds];
      } else {
        svcQuery = `SELECT * FROM services
                    WHERE subaccount_id = $1 AND active = true
                      AND type = 'class'
                    ORDER BY name ASC`;
        svcArgs = [subaccountId];
      }
    } else if (widgetServiceIds.length) {
      svcQuery = `SELECT * FROM services
                  WHERE subaccount_id = $1 AND active = true
                    AND id = ANY($2::text[])
                  ORDER BY name ASC`;
      svcArgs = [subaccountId, widgetServiceIds];
    } else {
      svcQuery = `SELECT * FROM services
                  WHERE subaccount_id = $1 AND active = true
                  ORDER BY name ASC`;
      svcArgs = [subaccountId];
    }

    const [svcResult, varResult] = await Promise.all([
      skipServiceQuery
        ? Promise.resolve({ rows: [] })
        : db.query(svcQuery, svcArgs),
      skipServiceQuery
        ? Promise.resolve({ rows: [] })
        : db.query(
            `SELECT sv.* FROM service_variations sv
             JOIN services s ON sv.service_id = s.id
             WHERE s.subaccount_id = $1 AND sv.active = true
             ORDER BY sv.service_id, sv.name`,
            [subaccountId]
          )
    ]);

    // 5. Staff
    let eligibleStaffIds = null;
    if (widgetType === 'service') {
      const staffSet = new Set();
      for (const svc of svcResult.rows) {
        const assigned = Array.isArray(svc.assigned_staff) ? svc.assigned_staff : [];
        for (const sid of assigned) staffSet.add(sid);
      }
      eligibleStaffIds = staffSet.size > 0 ? Array.from(staffSet) : null;
    } else if (widgetType === 'appointment') {
      const widgetStaffIds = widget && Array.isArray(widget.staff_ids) ? widget.staff_ids : [];
      eligibleStaffIds = widgetStaffIds.length > 0 ? widgetStaffIds : null;
    }

    let staffQuery, staffArgs;
    if (eligibleStaffIds && eligibleStaffIds.length) {
      staffQuery = `SELECT id, username, display_name, color, schedule, date_overrides
                    FROM subaccount_users
                    WHERE subaccount_id = $1 AND active = true
                      AND id = ANY($2::uuid[])
                    ORDER BY created_at ASC`;
      staffArgs = [subaccountId, eligibleStaffIds];
    } else {
      staffQuery = `SELECT id, username, display_name, color, schedule, date_overrides
                    FROM subaccount_users
                    WHERE subaccount_id = $1 AND active = true
                    ORDER BY created_at ASC`;
      staffArgs = [subaccountId];
    }
    const staffDbResult = await db.query(staffQuery, staffArgs);
    const publicStaff = staffDbResult.rows.map(u => ({
      id: u.id,
      name: u.display_name || u.username,
      color: u.color || '#6b21ea',
      schedule: u.schedule || {},
      dateOverrides: u.date_overrides || []
    }));

    // 5b. Class widgets: fetch upcoming sessions in the next 30 days.
    // BOTH today and the horizon are computed in the subaccount's TZ so
    // customers in the early hours of the day (UTC-wise) don't lose a day.
    let classSessions = [];
    if (widgetType === 'class') {
      const classServiceIds = svcResult.rows.map(s => s.id);
      if (classServiceIds.length) {
        const today = todayInTz(subTz);
        const horizonStr = dateInTzPlusDays(30, subTz);

        const sessionsResult = await db.query(
          `SELECT id, service_id, instructor_id, title, date, time, duration,
                  capacity, location, status, price, participants
           FROM class_sessions
           WHERE subaccount_id = $1
             AND service_id = ANY($2::text[])
             AND status = 'scheduled'
             AND date >= $3 AND date <= $4
           ORDER BY date ASC, time ASC`,
          [subaccountId, classServiceIds, today, horizonStr]
        );

        classSessions = sessionsResult.rows.map(s => {
          const parts = Array.isArray(s.participants) ? s.participants : [];
          const enrolled = parts.filter(p => p && p.status === 'enrolled').length;
          const cap = parseInt(s.capacity) || 10;
          return {
            id: s.id,
            service_id: s.service_id,
            instructor_id: s.instructor_id,
            title: s.title,
            date: s.date,
            time: s.time,
            duration: s.duration,
            capacity: cap,
            enrolled: enrolled,
            spots_remaining: Math.max(0, cap - enrolled),
            location: s.location,
            price: parseFloat(s.price) || 0
          };
        });
      }
    }

    // 6. Public-safe settings.
    // Per-widget config takes precedence over workspace blob defaults.
    // We expose only the fields the public page actually needs.
    const settings = blob.settings || {};
    const bs = settings.bookingSettings || {};
    const taxSettings = bs.tax || (settings.paySettings && settings.paySettings.tax) || {};
    // Default helpers for widget-vs-blob-vs-default precedence.
    const w = widget || {};
    const widgetBool = (val, def) => (val == null ? def : !!val);
    const publicSettings = {
      timezone:                subTz,
      businessHours:           settings.businessHours || {},
      businessName:            settings.businessName || slug,
      cancellation_policy_text: bs.cancellation_policy_text || '',

      // Tip: widget.allow_tip wins over blob default
      tip_enabled:             widgetBool(w.allow_tip, !!bs.tip_enabled),
      tip_percentages:         (Array.isArray(w.tip_percentages) && w.tip_percentages.length)
                                 ? w.tip_percentages
                                 : (bs.tip_percentages || [10, 15, 20]),
      tip_allow_custom:        bs.tip_allow_custom !== false,

      // Payment: per-widget config; payment_mode says HOW, require_payment says IF
      require_payment:         !!w.require_payment,
      payment_mode:            w.payment_mode || 'full',
      deposit_type:            w.deposit_type || null,
      deposit_value:           w.deposit_value != null ? parseFloat(w.deposit_value) : null,
      default_payment_mode:    bs.default_payment_mode || 'none',  // legacy/back-compat

      // Patient form
      allow_coupons:           widgetBool(w.allow_coupons, true),
      collect_phone:           widgetBool(w.collect_phone, true),
      collect_notes:           widgetBool(w.collect_notes, true),

      // Booking window (for client-side display of error context)
      booking_lead_time_hours: w.booking_lead_time_hours != null ? parseInt(w.booking_lead_time_hours) : null,
      booking_advance_days:    w.booking_advance_days != null ? parseInt(w.booking_advance_days) : null,

      tax: {
        enabled: !!taxSettings.enabled,
        rate: parseFloat(taxSettings.rate) || 0,
        label: taxSettings.label || 'Sales Tax'
      },
      widget_primary_color:    w.primary_color || bs.widget_primary_color || '#6b21ea',
      widget_logo_url:         w.logo_url || bs.widget_logo_url || '',
      widget_tagline:          w.tagline || bs.widget_tagline || '',
      widget_footer_text:      bs.widget_footer_text || '',
      confirm_message:         w.confirm_message || bs.confirmation_message || '',
      square_app_id:           settings.square?.appId || null,
      square_location_id:      settings.square?.locationId || null,
      square_sandbox:          settings.square?.sandbox !== false
    };

    return res.status(200).json({
      subaccount_id: subaccountId,
      slug,
      widget,
      services: svcResult.rows,
      variations: varResult.rows,
      class_sessions: classSessions,
      staff: publicStaff,
      settings: publicSettings
    });
  } catch (e) {
    console.error('booking-widget-data error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to load widget data' });
  }
}

exports.handler = wrap(handler);
