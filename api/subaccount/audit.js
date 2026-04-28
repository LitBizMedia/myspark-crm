// api/subaccount/audit.js
// Subaccount-side audit logging endpoint.
// Frontend calls this to log PHI access events. The server validates the
// session cookie and writes the audit_log row with server-derived actor info.
// The client cannot forge actor identity - whatever the cookie says, that's
// the user. Action and metadata come from the client (best-effort but trusted
// because the worst case is a logged-in user choosing not to log their own
// actions, which is detected by the absence of expected events).
//
// Accepts batched logs to support the buffered queue + sendBeacon flush path.
// Single-entry calls send { entries: [{...}] }, batched flushes also.
//
// Each entry shape:
//   {
//     action:     required string (e.g., 'subaccount.contact.view')
//     target_id:  optional string (e.g., contact ID)
//     target_type: optional string (e.g., 'contact', 'appointment')
//     metadata:   optional object (action-specific context)
//     outcome:    optional 'success' | 'failure' | 'denied', defaults 'success'
//     client_ts:  optional ISO timestamp (when the action happened on client)
//   }
//
// Server fills in:
//   - actor_id, actor_username, actor_role from session
//   - target_subaccount_id from session
//   - actor_type='subaccount'
//   - ip_address, user_agent from request
//   - created_at automatic

const { logAudit } = require('../../lib/audit');
const { parseSessionCookie, validateSession, getIpFromReq, getUserAgent } = require('../../lib/subaccount-auth');

const MAX_ENTRIES_PER_REQUEST = 50;

// Whitelist of action prefixes the frontend is allowed to log. Prevents
// a compromised client from writing arbitrary actions that could be confused
// with server-side audit events.
const ALLOWED_ACTION_PREFIXES = ['subaccount.'];

function isActionAllowed(action) {
  if (typeof action !== 'string' || action.length === 0 || action.length > 100) return false;
  return ALLOWED_ACTION_PREFIXES.some(function(p){ return action.startsWith(p); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate session
  const token = parseSessionCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
  }
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Subaccount session required', code: 'INVALID_SESSION' });
  }

  // Parse body. Accept either {entries: [...]} or single entry object.
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

  // Process each entry. Continue on individual failures so a bad entry
  // doesn't block valid ones.
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};
    const action = entry.action;

    if (!isActionAllowed(action)) {
      results.push({ index: i, ok: false, error: 'Invalid or unauthorized action: ' + action });
      continue;
    }

    // Sanitize metadata - cap size, ensure it's an object
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
};
