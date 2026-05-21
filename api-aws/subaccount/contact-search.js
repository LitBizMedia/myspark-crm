// GET /api/subaccount/contact-search
//
// Lightweight contact search for picker autocompletes. Returns minimal fields
// ranked by relevance (pg_trgm similarity).
//
// Query params:
//   q      - search query (required, min 2 chars)
//   limit  - max results (default 20, max 50)
//
// Response:
//   { matches: [{id, name, email, phone}], query, truncated }
//
// Performance: uses idx_contacts_search_trgm GIN index. Sub-10ms at 8000+ rows.
// Excludes archived contacts. Filters by subaccount_id for tenant isolation.
//
// Audit: logs query_length and match_count only. Never logs query text (PHI risk).

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

  // Parse and validate query
  const queryRaw = (qs.q || '').trim().toLowerCase();
  if (queryRaw.length < 2) {
    return res.status(200).json({ matches: [], query: queryRaw, truncated: false });
  }

  // Parse limit (default 20, max 50)
  let limit = parseInt(qs.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  // Query for limit+1 so we can detect truncation
  const fetchLimit = limit + 1;

  try {
    const result = await db.query(
      `SELECT
         id, display_name, email, phone,
         similarity(
           LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(phone, '') || ' ' || COALESCE(display_name, '')),
           $2
         ) AS score
       FROM contacts
       WHERE subaccount_id = $1
         AND archived = FALSE
         AND LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(phone, '') || ' ' || COALESCE(display_name, '')) LIKE $3
       ORDER BY score DESC, LOWER(display_name) ASC
       LIMIT $4`,
      [subaccountId, queryRaw, '%' + queryRaw + '%', fetchLimit]
    );

    const allMatches = result.rows;
    const truncated = allMatches.length > limit;
    const matches = allMatches.slice(0, limit).map(r => ({
      id: r.id,
      name: r.display_name,
      email: r.email,
      phone: r.phone
    }));

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.search',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        query_length: queryRaw.length,
        match_count: matches.length,
        truncated: truncated,
        limit: limit
      }
    });

    return res.status(200).json({
      matches: matches,
      query: queryRaw,
      truncated: truncated
    });
  } catch (err) {
    console.error('contact-search error:', err);
    return res.status(500).json({ error: 'Search failed', detail: err.message });
  }
}

exports.handler = wrap(handler);
