// api/subaccount/audit.js (Lambda version)
//
// POST /api/subaccount/audit
//
// Subaccount-side audit logging endpoint.
// Frontend calls this to log PHI access events. The server validates the
// session cookie and writes the audit_log row with server-derived actor info.
// Accepts batched logs to support the buffered queue + sendBeacon flush path.
//
// MIGRATED: uses lib/audit.logAudit which now writes via lib/db.

const { logAudit } = require('./lib/audit');
const { parseSessionCookie, validateSession, getIpFromReq, getUserAgent } = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

const MAX_ENTRIES_PER_REQUEST = 50;
const ALLOWED_ACTION_PREFIXES = ['subaccount.'];

function isActionAllowed(action) {
  if (typeof action !== 'string' || action.length === 0 || action.length > 100) return false;
  return ALLOWED_ACTION_PREFIXES.some(function(p){ return action.startsWith(p); });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
  }
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Subaccount session required', code: 'INVALID_SESSION' });
  }

  const body = req.body || {};
  let entries = Array.isArray(body.entries) ? body.entries : [body];
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No entries provided' });
  }
  if (entries.length > MAX_ENTRIES_PER_REQUEST) {
    return res.status(400).json({ error: 'Too many entries (max ' + MAX_ENTRIES_PER_REQUEST + ' per request)' });
  }

  const ipAddress = getIpFromReq(req);
  const userAgent = getUserAgent(req);

  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};
    const action = entry.action;

    if (!isActionAllowed(action)) {
      results.push({ index: i, ok: false, error: 'Invalid or unauthorized action: ' + action });
      continue;
    }

    let metadata = entry.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      try {
        const serialized = JSON.stringify(metadata);
        if (serialized.length > 8192) {
          metadata = { _truncated: true, _original_size: serialized.length };
        }
      } catch (e) {
        metadata = { _serialize_error: e.message };
      }
    } else {
      metadata = null;
    }

    if (entry.client_ts && typeof entry.client_ts === 'string') {
      metadata = metadata || {};
      metadata.client_ts = entry.client_ts;
    }

    try {
      await logAudit({
        req: {
          headers: {
            'x-forwarded-for': ipAddress || '',
            'user-agent': userAgent || ''
          }
        },
        session:              session,
        actorType:           'subaccount',
        actorId:              session.user_id,
        actorUsername:        session.username,
        actorRole:            session.role,
        action:               action,
        targetType:           entry.target_type || null,
        targetId:             entry.target_id || null,
        targetSubaccountId:   session.subaccount_id,
        outcome:              entry.outcome || 'success',
        errorMessage:         entry.error_message || null,
        metadata:             metadata
      });
      results.push({ index: i, ok: true });
    } catch (e) {
      console.error('audit endpoint: write failed for entry ' + i, e.message);
      results.push({ index: i, ok: false, error: 'Write failed' });
    }
  }

  const allOk = results.every(function(r){ return r.ok; });
  return res.status(allOk ? 200 : 207).json({
    success: allOk,
    written: results.filter(function(r){ return r.ok; }).length,
    total: entries.length,
    results: results
  });
}

exports.handler = wrap(handler);
