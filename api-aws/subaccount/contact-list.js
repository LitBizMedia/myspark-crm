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
    title: row.title,
    website: row.website,
    date_of_birth: row.date_of_birth instanceof Date ?
      (function(d){
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth()+1).padStart(2,'0');
        const da = String(d.getUTCDate()).padStart(2,'0');
        return y+'-'+m+'-'+da;
      })(row.date_of_birth) :
      row.date_of_birth,
    gender: row.gender,
    pronouns: row.pronouns,
    preferred_language: row.preferred_language,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state: row.state,
    postal_code: row.postal_code,
    country: row.country,
    timezone: row.timezone,
    emergency_contact_name: row.emergency_contact_name,
    emergency_contact_phone: row.emergency_contact_phone,
    emergency_contact_relationship: row.emergency_contact_relationship,
    source: row.source,
    type: row.type,
    status: row.status,
    archived: !!row.archived,
    tags: row.tags || [],
    customFieldValues: row.custom_field_values || {},
    creditBalance: row.credit_balance != null ? parseFloat(row.credit_balance) : 0,
    squareCustomerId: row.square_customer_id,
    squareCards: row.square_cards || [],
    sms_consent_transactional: !!row.sms_consent_transactional,
    sms_consent_marketing: !!row.sms_consent_marketing,
    sms_consent_updated_at: row.sms_consent_updated_at instanceof Date ? row.sms_consent_updated_at.toISOString() : row.sms_consent_updated_at,
    sms_consent_source: row.sms_consent_source,
    notes: [],
    warnings: [],
    allergies: [],
    creditHistory: [],
    warning_counts: row.warning_counts || { critical: 0, warning: 0, info: 0 },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    // Run main contact query and warning aggregate query in parallel
    const [result, warnAgg] = await Promise.all([
      db.query(
        `SELECT
           id, external_id,
           first_name, last_name, display_name,
           email, phone, company, title, website,
           date_of_birth, gender, pronouns, preferred_language,
           address_line1, address_line2, city, state, postal_code, country, timezone,
           emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
           source, type, status, archived, tags, custom_field_values,
           credit_balance, square_customer_id, square_cards,
           sms_consent_transactional, sms_consent_marketing, sms_consent_updated_at, sms_consent_source,
           created_at, updated_at, created_by, updated_by
         FROM contacts
         WHERE subaccount_id = $1
         ORDER BY created_at ASC`,
        [subaccountId]
      ),
      db.query(
        `SELECT contact_id, severity, COUNT(*)::int AS cnt
         FROM contact_warnings
         WHERE subaccount_id = $1
         GROUP BY contact_id, severity`,
        [subaccountId]
      )
    ]);

    // Build counts map: { contactId => { critical, warning, info } }
    const warningCountsMap = {};
    warnAgg.rows.forEach(r => {
      if(!warningCountsMap[r.contact_id]) warningCountsMap[r.contact_id] = { critical: 0, warning: 0, info: 0 };
      if(r.severity in warningCountsMap[r.contact_id]) warningCountsMap[r.contact_id][r.severity] = r.cnt;
    });

    // Attach counts to each row before shaping
    result.rows.forEach(row => {
      row.warning_counts = warningCountsMap[row.id] || { critical: 0, warning: 0, info: 0 };
    });

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
