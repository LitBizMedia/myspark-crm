// api/subaccount/eula-status.js
//
// GET /api/subaccount/eula-status
//
// Returns whether the CALLING user must accept the active EULA before using
// the platform. Reads the session via requireSubaccountAuth, so it only ever
// reports on the authenticated user. No user id is accepted from the client.
//
// Response:
//   { needsAcceptance: bool, version: string|null, title, bodyHtml,
//     impersonation: bool }
//
// When needsAcceptance is false (no active version, or already accepted, or
// this is an impersonation session) the frontend gate does nothing.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  // Impersonation sessions never gate. An agency admin acting as a user must
  // not be able to accept on that user's behalf, so we report no acceptance
  // needed and let the frontend skip the modal entirely.
  const isImpersonation = !!auth.impersonated_by_user_id;

  try {
    const av = await db.query(
      `SELECT version, title, body_html FROM eula_versions WHERE active = TRUE LIMIT 1`
    );
    const active = av.rows[0] || null;

    if (!active) {
      return res.status(200).json({ needsAcceptance: false, version: null, impersonation: isImpersonation });
    }

    if (isImpersonation) {
      return res.status(200).json({
        needsAcceptance: false,
        version: active.version,
        impersonation: true
      });
    }

    const accepted = await db.query(
      `SELECT id FROM eula_acceptances WHERE user_id = $1 AND eula_version = $2 LIMIT 1`,
      [auth.user_id, active.version]
    );
    const has = accepted.rows.length > 0;

    return res.status(200).json({
      needsAcceptance: !has,
      version: active.version,
      title: active.title || null,
      bodyHtml: has ? null : active.body_html,
      impersonation: false
    });
  } catch (e) {
    console.error('eula-status error:', e.message);
    // Fail OPEN on read errors: do not block login because a status check
    // failed. A user who should accept will be re-checked next login. Better
    // than locking everyone out if this endpoint has a transient fault.
    return res.status(200).json({ needsAcceptance: false, version: null, error: 'status_check_failed' });
  }
}

exports.handler = wrap(handler);
