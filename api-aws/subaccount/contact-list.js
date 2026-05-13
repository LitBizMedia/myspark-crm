// GET /api/subaccount/contact-list
//
// Returns ALL contacts for the authenticated subaccount in the camelCase
// shape the frontend expects (matches contactToFrontend in data-load.js).
//
// Child tables (notes, warnings, allergies, creditHistory) are NOT included
// here; they load on contact-open. Empty arrays are returned for those keys
// so the frontend shape stays consistent with what data-load used to return.
//
// This endpoint was split out of data-load on May 13, 2026 to keep the
// data-load response under Lambda's 6MB limit. Wildflower Wellness Spa hit
// 5.23MB of contacts alone at 6275 rows; data-load + contacts together
// blew past 6MB and threw RequestEntityTooLarge.
//
// Frontend boot sequence: data-load fires first (now without contacts),
// then contact-list fires immediately after and populates db.contacts.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

// Mirrors contactToFrontend() in data-load.js exactly, minus the child
// table joins. Keep these two shapes in sync forever.
function contactToFrontend(row) {
  if (!row) return row;
  // SLIM SHAPE: only fields the contacts list view + drawer headers need.
  // Heavy fields (notes, allergies, etc.) load on contact-open via dedicated endpoints.
  // Defensive empty defaults so existing frontend code reading .notes.length etc. works.
  return {
    id: row.id,
    external_id: row.external_id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: row.display_name,
    display_name: row.display_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    type: row.type,
    status: row.status,
    archived: !!row.archived,
    tags: row.tags || [],
    notes: [],
    warnings: [],
    allergies: [],
    creditHistory: [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const result = await db.query(
      `SELECT
         id, external_id,
         first_name, last_name, display_name,
         email, phone, company,
         type, status, archived, tags,
         created_at, updated_at
       FROM contacts
       WHERE subaccount_id = $1
       ORDER BY created_at ASC`,
      [subaccountId]
    );

    let contacts = result.rows.map(contactToFrontend);
    const total = contacts.length;

    // Guardrail: Lambda response cap is 6 MB. If payload approaches that due
    // to subaccount growth, return only what fits plus a truncated flag.
    // Frontend can warn or paginate. Threshold is 5 MB leaving headroom for
    // headers, base64 overhead from API Gateway, etc.
    const MAX_BYTES = 5 * 1024 * 1024;
    let serialized = JSON.stringify({ contacts });
    let truncated = false;
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      // Binary-search the largest prefix that fits.
      let lo = 0, hi = contacts.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const test = JSON.stringify({ contacts: contacts.slice(0, mid) });
        if (Buffer.byteLength(test) <= MAX_BYTES) lo = mid;
        else hi = mid - 1;
      }
      contacts = contacts.slice(0, lo);
      truncated = true;
      console.warn('contact-list truncated:', { returned: contacts.length, total, subaccountId });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.bulk_list',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: { contact_count: contacts.length, total_in_db: total, truncated: truncated }
    });

    return res.status(200).json({ contacts, total, truncated });
  } catch (err) {
    console.error('contact-list error:', err);
    return res.status(500).json({ error: 'Failed to load contacts', detail: err.message });
  }
}

exports.handler = wrap(handler);
