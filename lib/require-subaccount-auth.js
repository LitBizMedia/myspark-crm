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
//     // Use auth.subaccount_id instead of any slug/id from the request body.
//     // Trusting body fields is what enables IDOR attacks.
//   };
//
// For endpoints that accept a "slug" in the body (legacy pattern), enforce
// that auth.subaccount_id matches sub-{slug}. Reject otherwise:
//
//     const expectedId = 'sub-' + (req.body.slug || '');
//     if (auth.subaccount_id !== expectedId) {
//       return res.status(403).json({ error: 'Slug does not match session' });
//     }

const { parseSessionCookie, parseAgencySessionCookie, validateSession } = require('./subaccount-auth');
const { logAudit } = require('./audit');

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
      // Audit the unauthorized attempt
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

  return session;
}

// Validates the agency-specific HttpOnly session cookie (msp_agency_session).
// Agency and subaccount cookies are independent; one user can be logged into
// both an agency dashboard and a subaccount workspace in the same browser.
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

module.exports = {
  requireSubaccountAuth,
  requireAgencyAuth
};
