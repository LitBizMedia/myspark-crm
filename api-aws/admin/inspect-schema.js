const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
async function handler(req, res) {
  try {
    const out = {};
    
    out.subaccount_users = await db.query(`
      SELECT subaccount_id, id, username, display_name, color,
             (schedule IS NOT NULL) as has_schedule,
             (date_overrides IS NOT NULL) as has_overrides,
             jsonb_array_length(COALESCE(date_overrides, '[]'::jsonb)) as override_count
      FROM subaccount_users ORDER BY subaccount_id, created_at
    `).then(r => r.rows);
    
    out.appointments_distinct = await db.query(`
      SELECT subaccount_id, assigned_to, COUNT(*) as count
      FROM appointments
      WHERE assigned_to IS NOT NULL
      GROUP BY subaccount_id, assigned_to
      ORDER BY subaccount_id
    `).then(r => r.rows);
    
    out.services = await db.query(`
      SELECT id, subaccount_id, name, assigned_staff
      FROM services
      WHERE assigned_staff IS NOT NULL AND jsonb_array_length(assigned_staff) > 0
    `).then(r => r.rows);
    
    out.appt_orphans = await db.query(`
      SELECT a.assigned_to, COUNT(*) as count
      FROM appointments a
      LEFT JOIN subaccount_users u ON a.assigned_to = u.id::text
      WHERE a.assigned_to IS NOT NULL AND u.id IS NULL
      GROUP BY a.assigned_to
    `).then(r => r.rows);
    
    out.service_orphans = await db.query(`
      SELECT s.id, s.name, s.assigned_staff, sid as legacy_id
      FROM services s, jsonb_array_elements_text(s.assigned_staff) sid
      LEFT JOIN subaccount_users u ON sid = u.id::text
      WHERE u.id IS NULL
    `).then(r => r.rows).catch(e => ({ error: e.message }));
    
    return res.status(200).json(out);
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
exports.handler = wrap(handler);
