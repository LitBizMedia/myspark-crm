// api/agency/plans-list.js (Lambda version)
// GET /api/agency/plans-list[?subaccount_id=X]
// Returns subaccount_plans rows with linked contact info LEFT JOINed in
// when subaccount_plans.linked_contact_id is set.

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { subaccount_id } = req.query || {};

  const baseSQL = `
    SELECT
      p.*,
      c.id   AS _contact_id,
      c.first_name AS _contact_first_name,
      c.last_name  AS _contact_last_name,
      c.display_name AS _contact_display_name,
      c.email AS _contact_email,
      c.phone AS _contact_phone,
      c.litbiz_square_customer_id AS _contact_litbiz_square_customer_id
    FROM subaccount_plans p
    LEFT JOIN contacts c ON c.id = p.linked_contact_id AND c.subaccount_id = 'sub-litbiz'
  `;

  try {
    let r;
    if (subaccount_id) {
      r = await db.query(baseSQL + ' WHERE p.subaccount_id = $1', [subaccount_id]);
    } else {
      r = await db.query(baseSQL + ' ORDER BY p.created_at ASC');
    }

    // Hoist contact fields into linked_contact_info object, drop the underscore-prefixed columns
    const plans = r.rows.map(function (row) {
      const o = {};
      let contactInfo = null;
      for (const k in row) {
        if (k.indexOf('_contact_') === 0) {
          // Only build the contact obj if id is non-null
          if (k === '_contact_id' && row[k]) {
            contactInfo = contactInfo || {};
          }
        } else {
          o[k] = row[k];
        }
      }
      if (row._contact_id) {
        const nameFromParts = ((row._contact_first_name || '') + ' ' + (row._contact_last_name || '')).trim();
        contactInfo = {
          id: row._contact_id,
          name: row._contact_display_name || nameFromParts || row._contact_email || '(no name)',
          first_name: row._contact_first_name || '',
          last_name: row._contact_last_name || '',
          email: row._contact_email || '',
          phone: row._contact_phone || '',
          litbiz_square_customer_id: row._contact_litbiz_square_customer_id || null
        };
        o.linked_contact_info = contactInfo;
      } else {
        o.linked_contact_info = null;
      }
      return o;
    });

    return res.status(200).json({ plans });
  } catch (e) {
    console.error('plans-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
}

exports.handler = wrap(handler);
