// lib/audit.js
// Append-only audit logger for HIPAA compliance.
// Every billing, agency, and subaccount-affecting action calls logAudit().
//
// Design principles:
//   1. Never throw. Audit failures must not break the calling endpoint.
//   2. Capture server-observable fields (IP, user-agent) directly from req.
//   3. Snapshot actor identity at time of action (never resolve later from IDs).
//   4. Use dot-namespaced action strings: 'agency.plan.cancel', 'system.billing.charge_success'.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Extract client IP from common Vercel/proxy headers.
// Returns null if no header is present.
function getIpFromReq(req) {
  if (!req || !req.headers) return null;
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  return null;
}

function getUserAgent(req) {
  if (!req || !req.headers) return null;
  return req.headers['user-agent'] || null;
}

// Append a new audit log entry. Never throws. Failure is logged to the
// console but never blocks the caller.
//
// entry: {
//   req,                  // optional Vercel request, used to extract IP and user-agent
//   actorType,            // 'agency' | 'subaccount' | 'system' | 'cron'
//   actorId,              // agency_users.id, users.id, or 'system'
//   actorUsername,        // snapshot
//   actorRole,            // snapshot
//   action,               // required, dot-namespaced
//   targetType,           // 'subaccount' | 'plan' | 'card' | 'user' | 'agency_user'
//   targetId,             // specific record id
//   targetSubaccountId,   // which subaccount this action affected
//   metadata,             // any JSON-serializable details
//   outcome,              // 'success' | 'failure' | 'denied' (default 'success')
//   errorMessage          // only set when outcome is 'failure' or 'denied'
// }
async function logAudit(entry) {
  if (!entry || !entry.action) {
    console.error('logAudit called without an action');
    return;
  }

  try {
    const body = {
      actor_type:           entry.actorType || 'system',
      actor_id:             entry.actorId || null,
      actor_username:       entry.actorUsername || null,
      actor_role:           entry.actorRole || null,
      action:               entry.action,
      target_type:          entry.targetType || null,
      target_id:            entry.targetId || null,
      target_subaccount_id: entry.targetSubaccountId || null,
      ip_address:           getIpFromReq(entry.req),
      user_agent:           getUserAgent(entry.req),
      metadata:             entry.metadata || null,
      outcome:              entry.outcome || 'success',
      error_message:        entry.errorMessage || null
    };

    const res = await fetch(SUPABASE_URL + '/rest/v1/audit_log', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('logAudit: Supabase insert failed (' + res.status + '): ' + errText);
    }
  } catch (e) {
    // Audit failures never propagate.
    console.error('logAudit error:', e.message);
  }
}

// Helper: extract actor info from a request body that conforms to our convention.
// Frontend sends { ..., actor: { id, username, role } } in agency-initiated requests.
// This is currently client-asserted (spoofable). Will become trustworthy when
// proper server-side sessions are in place.
function extractActorFromBody(body) {
  const a = body && body.actor;
  if (!a) return { actorType: 'agency' };
  return {
    actorType: 'agency',
    actorId: a.id || null,
    actorUsername: a.username || null,
    actorRole: a.role || null
  };
}

module.exports = {
  logAudit,
  extractActorFromBody,
  getIpFromReq,
  getUserAgent
};
