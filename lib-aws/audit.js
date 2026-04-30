// lib/audit.js
// Append-only audit logger for HIPAA compliance.
// Every billing, agency, and subaccount-affecting action calls logAudit().
//
// Design principles:
//   1. Never throw. Audit failures must not break the calling endpoint.
//   2. Capture server-observable fields (IP, user-agent) directly from req.
//   3. Snapshot actor identity at time of action (never resolve later from IDs).
//   4. Use dot-namespaced action strings: 'agency.plan.cancel', 'system.billing.charge_success'.
//
// MIGRATED: from Supabase REST fetch to direct pg via lib/db.js.

const db = require('./db');

// Extract client IP from common Vercel/proxy headers.
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
async function logAudit(entry) {
  if (!entry || !entry.action) {
    console.error('logAudit called without an action');
    return;
  }

  try {
    const row = {
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

    await db.insertOne('audit_log', row, { returning: 'id' });
  } catch (e) {
    // Audit failures never propagate.
    console.error('logAudit error:', e.message);
  }
}

// Extract actor info from a request body that conforms to our convention.
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
