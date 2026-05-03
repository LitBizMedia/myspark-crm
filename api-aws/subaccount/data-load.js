// api/subaccount/data-load.js (Lambda version)
// GET /api/subaccount/data-load
// Loads the bulk subaccount_data JSONB blob plus services, variations, class
// sessions, users, and (post-migration) service_categories and service_widgets.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const [blobResult, servicesResult, variationsResult, classesResult, usersResult, widgetsResult] = await Promise.all([
      db.query(
        // Pull data blob and the new service_categories column in one query
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
      )
    ]);

    return res.status(200).json({
      data: blobResult.rows[0]?.data || null,
      services: servicesResult.rows,
      serviceVariations: variationsResult.rows,
      classSessions: classesResult.rows,
      users: usersResult.rows,
      // New fields from migrated tables/columns. Frontend prefers these
      // over anything that may still be in the blob during transition.
      serviceCategories: blobResult.rows[0]?.service_categories || [],
      serviceWidgets: widgetsResult.rows
    });
  } catch (e) {
    console.error('data-load error:', e.message);
    return res.status(500).json({ error: 'Failed to load data' });
  }
}

exports.handler = wrap(handler);
