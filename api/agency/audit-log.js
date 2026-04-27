// api/agency/audit-log.js
// Read audit log entries with filtering and pagination.
// Returns entries in reverse chronological order.
//
// Query params (all optional):
//   limit            - 1 to 200, default 50
//   offset           - default 0
//   subaccount       - filter by target_subaccount_id
//   actor            - filter by actor_id
//   actorType        - 'agency' | 'subaccount' | 'system' | 'cron'
//   action           - substring match (case-insensitive)
//   outcome          - 'success' | 'failure' | 'denied'
//   from             - ISO timestamp, gte
//   to               - ISO timestamp, lte
//
// Response:
//   { entries: [...], total: N, limit, offset }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendError(res, code, message) {
  return res.status(code).json({ error: message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset) || 0, 0);

  let url = SUPABASE_URL + '/rest/v1/audit_log?select=*&order=created_at.desc';
  url += '&limit=' + limit + '&offset=' + offset;

  if (q.subaccount) url += '&target_subaccount_id=eq.' + encodeURIComponent(q.subaccount);
  if (q.actor)      url += '&actor_id=eq.' + encodeURIComponent(q.actor);
  if (q.actorType)  url += '&actor_type=eq.' + encodeURIComponent(q.actorType);
  if (q.outcome)    url += '&outcome=eq.' + encodeURIComponent(q.outcome);
  if (q.action)     url += '&action=ilike.' + encodeURIComponent('*' + q.action + '*');
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
      return sendError(res, 500, 'Failed to load audit log: ' + errText);
    }

    const rows = await fetchRes.json();

    // Supabase returns total in Content-Range header when Prefer: count=exact
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
    console.error('audit-log read error:', e);
    return sendError(res, 500, 'Failed to load audit log: ' + e.message);
  }
};
