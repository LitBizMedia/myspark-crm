// lib/require-subaccount-auth.js
// Middleware-style helper for protecting subaccount-side API endpoints.
//
// Validates the HttpOnly session cookie set by /api/subaccount/login.
// On success, attaches req.user (the session record) and the calling
// handler can read req.user.subaccount_id, req.user.role, etc.
// On failure, sends a 401 and the handler does not run.
//
// Usage pattern in any subaccount-side endpoint:
//
//   const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');
//
//   module.exports = async function handler(req, res) {
//     const auth = await requireSubaccountAuth(req, res);
//     if (!auth) return; // 401 already sent
//
//     // From here on, auth.user_id, auth.subaccount_id, auth.role are trustworthy.
//   };
//
// MIGRATED: no direct DB calls in this file, but transitive dependencies
// (validateSession, logAudit) now use lib/db.js instead of Supabase REST.

const { parseSessionCookie, parseAgencySessionCookie, validateSession } = require('./subaccount-auth');
const { logAudit } = require('./audit');
const db = require('./db');

async function requireSubaccountAuth(req, res, opts) {
  opts = opts || {};
  const token = parseSessionCookie(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
    return null;
  }

  const session = await validateSession(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid', code: 'INVALID_SESSION' });
    return null;
  }

  // Optional role gate
  if (opts.requireRole) {
    const allowed = Array.isArray(opts.requireRole) ? opts.requireRole : [opts.requireRole];
    if (allowed.indexOf(session.role) < 0) {
      await logAudit({
        req,
        actorType: session.user_type,
        actorId: session.user_id,
        actorUsername: session.username,
        actorRole: session.role,
        action: 'subaccount.access.denied',
        targetSubaccountId: session.subaccount_id,
        outcome: 'denied',
        errorMessage: 'Insufficient role: required ' + allowed.join('/') + ', has ' + session.role,
        metadata: { endpoint: req.url || null }
      });
      res.status(403).json({ error: 'Insufficient permissions', code: 'INSUFFICIENT_ROLE' });
      return null;
    }
  }

  // Optional subaccount scope check
  if (opts.subaccountId && session.subaccount_id !== opts.subaccountId) {
    await logAudit({
      req,
      actorType: session.user_type,
      actorId: session.user_id,
      actorUsername: session.username,
      action: 'subaccount.access.denied',
      targetSubaccountId: opts.subaccountId,
      outcome: 'denied',
      errorMessage: 'Subaccount mismatch: session is for ' + session.subaccount_id + ', request targets ' + opts.subaccountId,
      metadata: { endpoint: req.url || null }
    });
    res.status(403).json({ error: 'Subaccount scope mismatch', code: 'SCOPE_MISMATCH' });
    return null;
  }

  // Attach session to req so logAudit (and any other downstream code) can
  // detect impersonation context without each handler having to pass it.
  // Underscore prefix avoids collision with anything else on req.
  if (req) req._session = session;

  return session;
}

// Validates the agency-specific HttpOnly session cookie (msp_agency_session).
async function requireAgencyAuth(req, res, opts) {
  opts = opts || {};
  const token = parseAgencySessionCookie(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated', code: 'NO_SESSION' });
    return null;
  }

  const session = await validateSession(token);
  if (!session || session.user_type !== 'agency') {
    res.status(401).json({ error: 'Agency session required', code: 'INVALID_SESSION' });
    return null;
  }

  if (opts.requireRole) {
    const allowed = Array.isArray(opts.requireRole) ? opts.requireRole : [opts.requireRole];
    if (allowed.indexOf(session.role) < 0) {
      res.status(403).json({ error: 'Insufficient permissions', code: 'INSUFFICIENT_ROLE' });
      return null;
    }
  }

  return session;
}

// Validates that a subaccount session belongs to an agency admin within
// an agency workspace. Performs live DB checks on EVERY request so that
// revoking is_agency_admin or is_agency_workspace takes effect immediately,
// without waiting for session expiry.
//
// Three gates, all must pass:
//   1. Valid subaccount session
//   2. subaccount_users.is_agency_admin = TRUE for the calling user
//   3. subaccount_plans.is_agency_workspace = TRUE for the calling subaccount
//
// Returns the session object (same shape as requireSubaccountAuth) on success.
// Sends 401/403 and returns null on failure.
//
// Every failure path is audit-logged with actorType = 'agency_admin' so that
// attempted privilege escalation is visible in the Agency Audit view.
//
// Usage:
//   const { requireAgencyAdmin } = require('../../lib/require-subaccount-auth');
//
//   module.exports = async function handler(req, res) {
//     const auth = await requireAgencyAdmin(req, res);
//     if (!auth) return; // 401/403 already sent
//     // auth.user_id, auth.subaccount_id, auth.role available
//   };
async function requireAgencyAdmin(req, res, opts) {
  opts = opts || {};

  // Gate 1: valid subaccount session
  const session = await requireSubaccountAuth(req, res, {});
  if (!session) return null; // 401 already sent

  // Gate 2: user must have is_agency_admin = TRUE
  // Live DB check, not cached, so revocation is immediate.
  let userRow;
  try {
    userRow = await db.findOne('subaccount_users', { id: session.user_id });
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed', code: 'AUTH_CHECK_FAILED' });
    return null;
  }

  if (!userRow || userRow.is_agency_admin !== true) {
    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: session.user_id,
      actorUsername: session.username,
      actorRole: session.role,
      action: 'agency.access.denied',
      targetSubaccountId: session.subaccount_id,
      outcome: 'denied',
      errorMessage: 'User is not an agency admin',
      metadata: { endpoint: req.url || null, reason: 'not_agency_admin' }
    });
    res.status(403).json({ error: 'Agency admin access required', code: 'NOT_AGENCY_ADMIN' });
    return null;
  }

  // Gate 3: subaccount must be the agency workspace
  let planRow;
  try {
    planRow = await db.findOne('subaccount_plans', { subaccount_id: session.subaccount_id });
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed', code: 'AUTH_CHECK_FAILED' });
    return null;
  }

  if (!planRow || planRow.is_agency_workspace !== true) {
    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: session.user_id,
      actorUsername: session.username,
      actorRole: session.role,
      action: 'agency.access.denied',
      targetSubaccountId: session.subaccount_id,
      outcome: 'denied',
      errorMessage: 'Subaccount is not an agency workspace',
      metadata: { endpoint: req.url || null, reason: 'not_agency_workspace' }
    });
    res.status(403).json({ error: 'Agency workspace required', code: 'NOT_AGENCY_WORKSPACE' });
    return null;
  }

  // All three gates passed. Return session with agency_admin marker for
  // downstream audit logging convenience.
  session.is_agency_admin = true;
  return session;
}

// Dual-auth helper for read endpoints that need to serve BOTH the /agency
// portal AND the LitBiz workspace Agency Tools tabs.
//
// Tries requireAgencyAdmin first (subaccount session with is_agency_admin=true
// in an agency workspace). If that fails with a non-401 error path, we don't
// fall through (the helper already sent a response). If it failed because
// there's no subaccount session cookie at all, we then try requireAgencyAuth.
//
// Use for READ-ONLY endpoints only. Write endpoints should pick one auth
// path explicitly to keep audit trails clean.
async function requireAgencyAdminOrAgencyAuth(req, res, opts) {
  opts = opts || {};

  // Probe for subaccount session cookie. If present, route through agency_admin.
  const subToken = parseSessionCookie(req);
  if (subToken) {
    // Use a buffered response shim so failed agency_admin auth doesn't
    // permanently consume the response. If it fails, try agency auth next.
    let intercepted = null;
    const shim = {
      status: function(code) {
        return {
          json: function(body) { intercepted = { code: code, body: body }; return this; }
        };
      },
      setHeader: function() {}
    };
    const adminAuth = await requireAgencyAdmin(req, shim, opts);
    if (adminAuth) return adminAuth;
    // requireAgencyAdmin failed. If the failure was NO_SESSION or INVALID_SESSION,
    // try the agency cookie path. If it was NOT_AGENCY_ADMIN or NOT_AGENCY_WORKSPACE,
    // the user has a subaccount session but isn't authorized; deny outright.
    const failCode = intercepted && intercepted.body && intercepted.body.code;
    if (failCode === 'NOT_AGENCY_ADMIN' || failCode === 'NOT_AGENCY_WORKSPACE') {
      res.status(403).json(intercepted.body);
      return null;
    }
    // Otherwise fall through to agency auth probe below.
  }

  // No subaccount session OR subaccount session was invalid. Try agency cookie.
  const agencyAuth = await requireAgencyAuth(req, res, opts);
  if (agencyAuth) return agencyAuth;

  // Both failed. requireAgencyAuth already sent the response. Return null.
  return null;
}

module.exports = {
  requireSubaccountAuth,
  requireAgencyAuth,
  requireAgencyAdmin,
  requireAgencyAdminOrAgencyAuth
};
