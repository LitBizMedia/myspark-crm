// GET /api/subaccount/contact-list
//
// Paginated, searchable, sortable contact list for the contacts panel.
//
// Query params:
//   page          - 1-indexed page number (default 1)
//   page_size     - rows per page, max 200 (default 50)
//   search        - fuzzy match across name, email, phone (min 2 chars)
//   sort          - created_desc | created_asc | name_asc | name_desc | email_asc
//   archived      - false (default) | true | all
//   type          - filter by contact type (lead | client | partner | employee | lapsed)
//   status        - filter by status (active | inactive)
//   tag           - filter by tag id (must be present in tags JSONB array)
// (legacy=1 emergency fallback removed in Stage 3 cleanup, May 21 2026)
//
// Response shape:
//   { contacts, page, page_size, total, total_pages, has_next, has_prev }
//
// Performance: uses idx_contacts_subaccount_created for sort, idx_contacts_search_trgm
// for fuzzy search. Sub-10ms queries at 8000+ rows.
//
// History:
//   May 13, 2026 - Split out of data-load to keep response under 6MB cap
//   May 21, 2026 - Pagination added after Wildflower hit 5MB truncation cap

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

// Shared shape function. Mirrors contactToFrontend in data-load.js.
// Heavy fields (notes, allergies, etc.) load on contact-open.
function contactToFrontend(row) {
  if (!row) return row;
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

// Map sort param to ORDER BY clause. Whitelist prevents SQL injection.
const SORT_MAP = {
  created_desc: 'created_at DESC, id DESC',
  created_asc: 'created_at ASC, id ASC',
  name_asc: 'LOWER(display_name) ASC, id ASC',
  name_desc: 'LOWER(display_name) DESC, id DESC',
  email_asc: 'LOWER(COALESCE(email, \'~\')) ASC, id ASC'
};

const SELECT_COLS = `
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
`;

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const qs = req.query || {};

  // Parse pagination params
  let page = parseInt(qs.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let pageSize = parseInt(qs.page_size, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 50;
  if (pageSize > 200) pageSize = 200;

  const offset = (page - 1) * pageSize;

  // Parse search (min 2 chars, else ignore)
  const searchRaw = (qs.search || '').trim().toLowerCase();
  const search = searchRaw.length >= 2 ? searchRaw : null;

  // Parse sort (whitelist)
  const sortKey = qs.sort && SORT_MAP[qs.sort] ? qs.sort : 'created_desc';
  const orderBy = SORT_MAP[sortKey];

  // Parse archived filter
  const archivedRaw = (qs.archived || 'false').toLowerCase();
  let archivedFilter;
  if (archivedRaw === 'true') archivedFilter = 'AND archived = TRUE';
  else if (archivedRaw === 'all') archivedFilter = '';
  else archivedFilter = 'AND archived = FALSE';

  // Parse type filter (whitelist)
  const TYPE_WHITELIST = ['lead', 'client', 'partner', 'employee', 'lapsed'];
  const typeRaw = (qs.type || '').toLowerCase().trim();
  const typeFilter = TYPE_WHITELIST.includes(typeRaw) ? typeRaw : null;

  // Parse status filter (whitelist)
  const STATUS_WHITELIST = ['active', 'inactive'];
  const statusRaw = (qs.status || '').toLowerCase().trim();
  const statusFilter = STATUS_WHITELIST.includes(statusRaw) ? statusRaw : null;

  // Parse tag filter (just a string, validated against JSONB containment)
  const tagFilter = (qs.tag || '').trim() || null;

  // Build WHERE clause
  const params = [subaccountId];
  let whereSearch = '';
  if (search) {
    params.push('%' + search + '%');
    whereSearch = `AND LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(phone, '') || ' ' || COALESCE(display_name, '')) LIKE $${params.length}`;
  }

  let whereType = '';
  if (typeFilter) {
    params.push(typeFilter);
    whereType = `AND type = $${params.length}`;
  }

  let whereStatus = '';
  if (statusFilter) {
    params.push(statusFilter);
    whereStatus = `AND status = $${params.length}`;
  }

  let whereTag = '';
  if (tagFilter) {
    params.push(JSON.stringify([tagFilter]));
    whereTag = `AND tags @> $${params.length}::jsonb`;
  }

  const whereClause = `WHERE subaccount_id = $1 ${archivedFilter} ${whereSearch} ${whereType} ${whereStatus} ${whereTag}`;

  // Add pagination params
  params.push(pageSize);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  try {
    // Parallel queries: page data, total count, warning aggregates for this page
    const [pageResult, countResult] = await Promise.all([
      db.query(
        `SELECT ${SELECT_COLS}
         FROM contacts
         ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM contacts ${whereClause}`,
        params.slice(0, params.length - 2)
      )
    ]);

    const contactIds = pageResult.rows.map(r => r.id);

    // Warning counts only for contacts on this page
    let warnAgg = { rows: [] };
    if (contactIds.length > 0) {
      warnAgg = await db.query(
        `SELECT contact_id, severity, COUNT(*)::int AS cnt
         FROM contact_warnings
         WHERE subaccount_id = $1 AND contact_id = ANY($2)
         GROUP BY contact_id, severity`,
        [subaccountId, contactIds]
      );
    }

    const warningCountsMap = {};
    warnAgg.rows.forEach(r => {
      if (!warningCountsMap[r.contact_id]) warningCountsMap[r.contact_id] = { critical: 0, warning: 0, info: 0 };
      if (r.severity in warningCountsMap[r.contact_id]) warningCountsMap[r.contact_id][r.severity] = r.cnt;
    });

    pageResult.rows.forEach(row => {
      row.warning_counts = warningCountsMap[row.id] || { critical: 0, warning: 0, info: 0 };
    });

    const contacts = pageResult.rows.map(contactToFrontend);
    const total = countResult.rows[0].total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.list_page',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        page: page,
        page_size: pageSize,
        sort: sortKey,
        has_search: !!search,
        search_length: search ? search.length : 0,
        archived_filter: archivedRaw,
        type_filter: typeFilter,
        status_filter: statusFilter,
        has_tag_filter: !!tagFilter,
        total: total,
        returned: contacts.length
      }
    });

    return res.status(200).json({
      contacts: contacts,
      page: page,
      page_size: pageSize,
      total: total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1
    });
  } catch (err) {
    console.error('contact-list error:', err);
    return res.status(500).json({ error: 'Failed to load contacts', detail: err.message });
  }
}

// Legacy mode: returns the pre-pagination shape with the 5MB truncation guardrail.
// handleLegacy removed May 21 2026 (Stage 3 cleanup). The legacy=1 query
// param was a safety net during Stage 2 pagination rollout. With pickers,
// dedup, and display all migrated, the fallback is no longer needed.

exports.handler = wrap(handler);
