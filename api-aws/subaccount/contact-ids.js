// GET /api/subaccount/contact-ids
//
// Returns the array of contact IDs matching the same filters as contact-list.
// Used by the "Select all matching" feature in the contacts panel toolbar.
//
// Query params: same as contact-list (search, type, status, tag, archived)
// Pagination params (page, page_size) are NOT honored; returns ALL matching IDs.
//
// Response:
//   { ids: ["id1", "id2", ...], count: 8329 }
//
// Audit: logs filter set and count, never the IDs themselves.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const qs = req.query || {};

  // Parse same filters as contact-list (skip pagination/sort)
  const searchRaw = (qs.search || '').trim().toLowerCase();
  const search = searchRaw.length >= 2 ? searchRaw : null;

  const archivedRaw = (qs.archived || 'false').toLowerCase();
  let archivedFilter;
  if (archivedRaw === 'true') archivedFilter = 'AND archived = TRUE';
  else if (archivedRaw === 'all') archivedFilter = '';
  else archivedFilter = 'AND archived = FALSE';

  const TYPE_WHITELIST = ['lead', 'client', 'partner', 'employee', 'lapsed'];
  const typeRaw = (qs.type || '').toLowerCase().trim();
  const typeFilter = TYPE_WHITELIST.includes(typeRaw) ? typeRaw : null;

  const STATUS_WHITELIST = ['active', 'inactive'];
  const statusRaw = (qs.status || '').toLowerCase().trim();
  const statusFilter = STATUS_WHITELIST.includes(statusRaw) ? statusRaw : null;

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

  try {
    const result = await db.query(
      `SELECT id FROM contacts ${whereClause} ORDER BY created_at DESC, id DESC`,
      params
    );

    const ids = result.rows.map(r => r.id);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.list_ids',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        count: ids.length,
        has_search: !!search,
        type_filter: typeFilter,
        status_filter: statusFilter,
        has_tag_filter: !!tagFilter,
        archived_filter: archivedRaw
      }
    });

    return res.status(200).json({ ids, count: ids.length });
  } catch (err) {
    console.error('contact-ids error:', err);
    return res.status(500).json({ error: 'Failed to load contact IDs', detail: err.message });
  }
}

exports.handler = wrap(handler);
