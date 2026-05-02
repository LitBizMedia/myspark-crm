const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const r = await db.query(`
      SELECT subaccount_id,
             data ? 'users' as has_users,
             data ? '_subaccountAdmin' as has_subaccountAdmin,
             data->'settings' ? 'adminProfile' as has_adminProfile,
             data->'settings' ? 'supabaseUrl' as has_supabaseUrl,
             data->'settings' ? 'supabaseKey' as has_supabaseKey,
             jsonb_array_length(COALESCE(data->'appointments', '[]'::jsonb)) as appointments_count,
             jsonb_array_length(COALESCE(data->'contacts', '[]'::jsonb)) as contacts_count
      FROM subaccount_data
      ORDER BY subaccount_id
    `);
    return res.status(200).json({ after: r.rows });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
