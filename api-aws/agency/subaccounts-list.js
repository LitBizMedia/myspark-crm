// api/agency/subaccounts-list.js (Lambda version)
// GET /api/agency/subaccounts-list[?include_data=true]
// Returns all subaccounts with RDS-sourced contact + user counts, optionally with blob data.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const includeData = (req.query && req.query.include_data === 'true');

  try {
    const subs = await db.query(
      'SELECT * FROM subaccounts ORDER BY created_at ASC'
    );

    // RDS aggregates for stats display (contacts moved to RDS May 12, users May 2).
    const contactCounts = await db.query(
      `SELECT subaccount_id, COUNT(*)::int AS n
       FROM contacts
       WHERE archived = false OR archived IS NULL
       GROUP BY subaccount_id`
    );
    const userCounts = await db.query(
      `SELECT subaccount_id, COUNT(*)::int AS n
       FROM subaccount_users
       WHERE active = true
       GROUP BY subaccount_id`
    );

    const contactMap = {};
    contactCounts.rows.forEach(r => { contactMap[r.subaccount_id] = r.n; });
    const userMap = {};
    userCounts.rows.forEach(r => { userMap[r.subaccount_id] = r.n; });

    // Decorate each subaccount with counts
    const decorated = subs.rows.map(s => ({
      ...s,
      contact_count: contactMap[s.id] || 0,
      user_count: userMap[s.id] || 0
    }));

    let dataMap = {};
    if (includeData) {
      const rows = await db.query(
        'SELECT subaccount_id, data FROM subaccount_data'
      );
      rows.rows.forEach(r => { dataMap[r.subaccount_id] = r.data; });
    }

    return res.status(200).json({
      subaccounts: decorated,
      data_map: includeData ? dataMap : null
    });
  } catch (e) {
    console.error('subaccounts-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load subaccounts' });
  }
}

exports.handler = wrap(handler);
