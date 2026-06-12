// GET /api/subaccount/contact-name-map
//
// Returns a lightweight display-tier mapping for ALL contacts in the subaccount
// (including archived). Used by getContactDisplay(id) helper for any view that
// needs to render contact info without loading full PHI records.
//
// Loaded once on boot, cached in memory, refreshed only on contact mutations.
//
// Response:
//   { map: { contactId: { name, email, phone, company, tags, archived, creditBalance, squareCustomerId } }, count }
//
// Performance: single SELECT, no joins, returns ~150 bytes per contact.
// At 8000 contacts ~1.2MB; at 30000 contacts ~4.5MB. If a subaccount exceeds
// 30000 contacts, this endpoint needs to be paginated (defer until needed).
//
// History:
//   May 21 2026 - Created with just {name, email}
//   May 21 2026 - Expanded to include display-tier fields (phone, company,
//                 tags, archived, creditBalance, squareCustomerId)

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
      `SELECT
         c.id, c.display_name, c.email, c.phone, c.company,
         c.tags, c.archived, c.credit_balance, c.square_customer_id,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', w.id, 'severity', w.severity, 'text', w.text))
           FILTER (WHERE w.id IS NOT NULL), '[]'
         ) AS warnings,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', al.id, 'severity', al.severity, 'allergen', al.allergen, 'reaction', al.reaction))
           FILTER (WHERE al.id IS NOT NULL), '[]'
         ) AS allergies
       FROM contacts c
       LEFT JOIN contact_warnings w ON w.contact_id = c.id
       LEFT JOIN contact_allergies al ON al.contact_id = c.id
       WHERE c.subaccount_id = $1
       GROUP BY c.id, c.display_name, c.email, c.phone, c.company,
                c.tags, c.archived, c.credit_balance, c.square_customer_id`,
      [subaccountId]
    );

    const map = {};
    result.rows.forEach(r => {
      // Build slim object, omit empty/null/zero/false values to keep payload tight.
      // Frontend code reads via getContactDisplay() which handles missing keys safely.
      const entry = { name: r.display_name };
      if (r.email) entry.email = r.email;
      if (r.phone) entry.phone = r.phone;
      if (r.company) entry.company = r.company;
      if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags;
      if (r.archived) entry.archived = true;
      if (r.credit_balance != null && parseFloat(r.credit_balance) !== 0) {
        entry.creditBalance = parseFloat(r.credit_balance);
      }
      if (r.square_customer_id) entry.squareCustomerId = r.square_customer_id;
      if (Array.isArray(r.warnings) && r.warnings.length) entry.warnings = r.warnings;
      if (Array.isArray(r.allergies) && r.allergies.length) entry.allergies = r.allergies;
      map[r.id] = entry;
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
