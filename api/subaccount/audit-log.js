// api/subaccount/audit-log.js
// Read audit log entries for the calling subaccount only.
// Server enforces the scope: a subaccount admin can never read another
// subaccount's logs even by manipulating query parameters. The session
// determines what subaccount_id filters the query.
//
// Admin role required. Regular subaccount users cannot read the audit log.

const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendError(res, code, message) {
  return res.status(code).json({ error: message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  // Admin role required to view audit logs
  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return; // 401/403 already sent

  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset) || 0, 0);

  // CRITICAL: scope is from session, NEVER from query params. This prevents
  // a malicious admin from reading another subaccount's logs by passing
  // a different subaccount_id in the URL.
  const scopedSubaccountId = auth.subaccount_id;

  let url = SUPABASE_URL + '/rest/v1/audit_log?select=*&order=created_at.desc';
  url += '&target_subaccount_id=eq.' + encodeURIComponent(scopedSubaccountId);
  url += '&limit=' + limit + '&offset=' + offset;

  if (q.actor)     url += '&actor_id=eq.' + encodeURIComponent(q.actor);
  if (q.outcome)   url += '&outcome=eq.' + encodeURIComponent(q.outcome);
  if (q.action)    url += '&action=ilike.' + encodeURIComponent('*' + q.action + '*');
  if (q.from)      url += '&created_at=gte.' + encodeURIComponent(q.from);
  if (q.to)        url += '&created_at=lte.' + encodeURIComponent(q.to);
  if (q.target_id) url += '&target_id=eq.' + encodeURIComponent(q.target_id);

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
    console.error('subaccount audit-log read error:', e);
    return sendError(res, 500, 'Failed to load audit log: ' + e.message);
  }
};
