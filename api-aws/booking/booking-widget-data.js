// api/booking/booking-widget-data.js
// GET /api/booking/widget-data?slug=SLUG&widget_id=WIDGET_ID
// PUBLIC - no auth required
// Returns all data the booking widget needs to render

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, widget_id } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  try {
    // 1. Look up subaccount
    const saResult = await db.query(
      'SELECT id FROM subaccounts WHERE slug = $1 LIMIT 1',
      [slug]
    );
    if (!saResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const subaccountId = saResult.rows[0].id;

    // 2. Get data blob (settings, users, business hours, widgets)
    const blobResult = await db.query(
      'SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
      [subaccountId]
    );
    const blob = blobResult.rows[0]?.data || {};

    // 3. Get active services
    const [svcResult, varResult] = await Promise.all([
      db.query(
        'SELECT * FROM services WHERE subaccount_id = $1 AND active = true ORDER BY name ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT sv.* FROM service_variations sv
         JOIN services s ON sv.service_id = s.id
         WHERE s.subaccount_id = $1 AND sv.active = true
         ORDER BY sv.service_id, sv.name`,
        [subaccountId]
      )
    ]);

    // 4. Find widget config
    const widgets = blob.serviceWidgets || [];
    let widget = widget_id ? widgets.find(w => w.id === widget_id) : widgets[0];

    // 5. Public staff list from agency_users table (blob.users is unreliable)
    const staffResult = await db.query(
      `SELECT id, username, name, color, role, schedule, date_overrides
       FROM agency_users
       WHERE subaccount_id = $1 AND active = true
       ORDER BY created_at ASC`,
      [subaccountId]
    );
    const publicStaff = staffResult.rows.map(u => ({
      id: u.id,
      name: u.name || u.username,
      color: u.color || '#6b21ea',
      schedule: u.schedule || {},
      dateOverrides: u.date_overrides || []
    }));

    // 6. Filter services by widget
    let services = svcResult.rows;
    if (widget?.service_ids?.length) {
      services = services.filter(s => widget.service_ids.includes(s.id));
    }

    // 7. Public-safe settings
    const settings = blob.settings || {};
    const bs = settings.bookingSettings || {};
    const publicSettings = {
      timezone:                settings.timezone || 'America/Chicago',
      businessHours:           settings.businessHours || {},
      businessName:            settings.businessName || slug,
      cancellation_policy_text: bs.cancellation_policy_text || '',
      tip_enabled:             bs.tip_enabled || false,
      tip_percentages:         bs.tip_percentages || [10, 15, 20],
      tip_allow_custom:        bs.tip_allow_custom !== false,
      default_payment_mode:    bs.default_payment_mode || 'none',
      widget_primary_color:    widget?.primary_color || bs.widget_primary_color || '#6b21ea',
      widget_logo_url:         widget?.logo_url || bs.widget_logo_url || '',
      widget_tagline:          widget?.tagline || bs.widget_tagline || '',
      widget_footer_text:      bs.widget_footer_text || '',
      square_app_id:           settings.square?.appId || null,
      square_location_id:      settings.square?.locationId || null,
      square_sandbox:          settings.square?.sandbox !== false
    };

    return res.status(200).json({
      subaccount_id: subaccountId,
      slug,
      widget: widget || null,
      services,
      variations: varResult.rows,
      staff: publicStaff,
      settings: publicSettings
    });
  } catch (e) {
    console.error('booking-widget-data error:', e.message);
    return res.status(500).json({ error: 'Failed to load widget data' });
  }
}

exports.handler = wrap(handler);
