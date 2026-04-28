// api/agency/list-invoices.js
// Returns recent billing transactions joined with subaccount names.
// Reverse chronological order. Filters and pagination supported.
//
// Query params (all optional):
//   limit         - 1 to 200, default 50
//   offset        - default 0
//   subaccount    - filter by subaccount_id
//   status        - 'pending' | 'succeeded' | 'failed' | 'refunded'
//   from          - ISO date, gte
//   to            - ISO date, lte
//
// Response: { entries, total, limit, offset }

const { requireAgencyAuth } = require('../../lib/require-subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendError(res, code, message) {
  return res.status(code).json({ error: message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
  // Require valid agency session
  const auth = await requireAgencyAuth(req, res);
  if (!auth) return; // 401 already sent

  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset) || 0, 0);

  // Use the embedding feature in PostgREST to inline subaccount name.
  // This requires the foreign key from subaccount_invoices.subaccount_id to subaccounts.id
  // to be discoverable by PostgREST.
  let url = SUPABASE_URL + '/rest/v1/subaccount_invoices?select=*,subaccounts(id,name,slug)';
  url += '&order=created_at.desc';
  url += '&limit=' + limit + '&offset=' + offset;

  if (q.subaccount) url += '&subaccount_id=eq.' + encodeURIComponent(q.subaccount);
  if (q.status)     url += '&status=eq.' + encodeURIComponent(q.status);
  if (q.from)       url += '&created_at=gte.' + encodeURIComponent(q.from);
  if (q.to)         url += '&created_at=lte.' + encodeURIComponent(q.to);

  try {
    const fetchRes = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'count=exact'
      }
    });

    if (!fetchRes.ok) {
      const errText = await fetchRes.text();
      return sendError(res, 500, 'Failed to load invoices: ' + errText);
    }

    const rows = await fetchRes.json();
    const contentRange = fetchRes.headers.get('content-range') || '';
    const totalStr = contentRange.split('/')[1] || '0';
    const total = parseInt(totalStr) || 0;

    return res.status(200).json({
      entries: rows,
      total: total,
      limit: limit,
      offset: offset
    });

  } catch (e) {
    console.error('list-invoices error:', e);
    return sendError(res, 500, 'Failed to load invoices: ' + e.message);
  }
};
