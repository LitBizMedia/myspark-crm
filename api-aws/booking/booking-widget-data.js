// api/booking/booking-widget-data.js
// GET /api/booking/widget-data?slug=SLUG&widget_id=WIDGET_ID
// PUBLIC - no auth required
// Returns all data the booking widget needs to render
//
// CHANGED 2026-05-05: widget config now read from service_widgets RDS table,
// not from blob.serviceWidgets. Includes new fields: staff_mode, staff_ids,
// require_payment, intake_form_id, confirm_message.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

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
        `SELECT id, name, service_ids, primary_color, logo_url, tagline, active,
                staff_mode, staff_ids, round_robin_config, require_payment,
                intake_form_id, confirm_message
         FROM service_widgets
         WHERE id = $1 AND subaccount_id = $2 AND active = TRUE
         LIMIT 1`,
        [widget_id, subaccountId]
      );
      if (!wResult.rows.length) {
        return res.status(404).json({ error: 'Widget not found or inactive' });
      }
      widget = wResult.rows[0];
    } else {
      // Fallback: pick first active widget (legacy support; new flows always pass widget_id)
      const wResult = await db.query(
        `SELECT id, name, service_ids, primary_color, logo_url, tagline, active,
                staff_mode, staff_ids, round_robin_config, require_payment,
                intake_form_id, confirm_message
         FROM service_widgets
         WHERE subaccount_id = $1 AND active = TRUE
         ORDER BY created_at ASC
         LIMIT 1`,
        [subaccountId]
      );
      widget = wResult.rows[0] || null;
    }

    // 3. Get blob for non-widget settings (workspace settings, not widget-specific)
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
      [subaccountId]
    );
    const blob = blobResult.rows[0]?.data || {};

    // 4. Get active services. If widget restricts services, filter them.
    const widgetServiceIds = widget && Array.isArray(widget.service_ids) ? widget.service_ids : [];
    let svcQuery, svcArgs;
    if (widgetServiceIds.length) {
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
      db.query(svcQuery, svcArgs),
      db.query(
        `SELECT sv.* FROM service_variations sv
         JOIN services s ON sv.service_id = s.id
         WHERE s.subaccount_id = $1 AND sv.active = true
         ORDER BY sv.service_id, sv.name`,
        [subaccountId]
      )
    ]);

    // 5. Staff: read from subaccount_users (single source of truth)
    // Filter by widget.staff_ids if staff_mode is 'specific' or 'round_robin'.
    const widgetStaffIds = widget && Array.isArray(widget.staff_ids) ? widget.staff_ids : [];
    const staffMode = widget && widget.staff_mode || 'any';
    const filterByWidgetStaff = (staffMode === 'specific' || staffMode === 'round_robin') && widgetStaffIds.length > 0;

    let staffQuery, staffArgs;
    if (filterByWidgetStaff) {
      staffQuery = `SELECT id, username, display_name, color, schedule, date_overrides
                    FROM subaccount_users
                    WHERE subaccount_id = $1 AND active = true
                      AND id = ANY($2::uuid[])
                    ORDER BY created_at ASC`;
      staffArgs = [subaccountId, widgetStaffIds];
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

    // 6. Public-safe settings (workspace level, plus widget-level overrides)
    const settings = blob.settings || {};
    const bs = settings.bookingSettings || {};
    const taxSettings = bs.tax || (settings.paySettings && settings.paySettings.tax) || {};
    const publicSettings = {
      timezone:                settings.timezone || 'America/Chicago',
      businessHours:           settings.businessHours || {},
      businessName:            settings.businessName || slug,
      cancellation_policy_text: bs.cancellation_policy_text || '',
      tip_enabled:             bs.tip_enabled || false,
      tip_percentages:         bs.tip_percentages || [10, 15, 20],
      tip_allow_custom:        bs.tip_allow_custom !== false,
      // Widget-level payment requirement overrides workspace default
      require_payment:         widget ? !!widget.require_payment : (bs.default_payment_mode === 'full'),
      default_payment_mode:    bs.default_payment_mode || 'none',
      tax: {
        enabled: !!taxSettings.enabled,
        rate: parseFloat(taxSettings.rate) || 0,
        label: taxSettings.label || 'Sales Tax'
      },
      widget_primary_color:    (widget && widget.primary_color) || bs.widget_primary_color || '#6b21ea',
      widget_logo_url:         (widget && widget.logo_url) || bs.widget_logo_url || '',
      widget_tagline:          (widget && widget.tagline) || bs.widget_tagline || '',
      widget_footer_text:      bs.widget_footer_text || '',
      confirm_message:         (widget && widget.confirm_message) || bs.confirmation_message || '',
      square_app_id:           settings.square?.appId || null,
      square_location_id:      settings.square?.locationId || null,
      square_sandbox:          settings.square?.sandbox !== false
    };

    return res.status(200).json({
      subaccount_id: subaccountId,
      slug,
      widget,                    // full widget row (includes new fields)
      services: svcResult.rows,
      variations: varResult.rows,
      staff: publicStaff,
      settings: publicSettings
    });
  } catch (e) {
    console.error('booking-widget-data error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to load widget data' });
  }
}

exports.handler = wrap(handler);
