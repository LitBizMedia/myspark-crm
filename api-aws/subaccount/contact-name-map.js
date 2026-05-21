// GET /api/subaccount/contact-name-map
//
// Returns a lightweight ID-to-name mapping for ALL contacts in the subaccount
// (including archived). Used for display lookups in calendar, appointments,
// payment history, and any view that needs a contact name without loading
// full records.
//
// Loaded once on boot, cached in memory, refreshed only on contact mutations.
//
// Response:
//   { map: { contactId: { name, email } }, count }
//
// Performance: single SELECT, no joins, returns ~80 bytes per contact.
// At 8000 contacts ~640KB; at 50000 contacts ~4MB. If a subaccount exceeds
// 50000 contacts, this endpoint needs to be paginated too (defer until
// any client reaches that scale).

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const result = await db.query(
      `SELECT id, display_name, email
       FROM contacts
       WHERE subaccount_id = $1`,
      [subaccountId]
    );

    const map = {};
    result.rows.forEach(r => {
      map[r.id] = {
        name: r.display_name,
        email: r.email
      };
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.name_map',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: { count: result.rowCount }
    });

    return res.status(200).json({
      map: map,
      count: result.rowCount
    });
  } catch (err) {
    console.error('contact-name-map error:', err);
    return res.status(500).json({ error: 'Failed to load contact name map', detail: err.message });
  }
}

exports.handler = wrap(handler);
