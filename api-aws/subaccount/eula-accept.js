// api/subaccount/eula-accept.js
//
// POST /api/subaccount/eula-accept
//
// Records the CALLING user's acceptance of the currently active EULA version.
// Captures who (session user), which version (server-resolved, never trusted
// from the client), when (NOW), plus IP and user agent for the legal record.
//
// Guards:
//   - Impersonation sessions are REJECTED. An agency admin acting as a user
//     cannot accept on that user's behalf, even with a crafted request.
//   - Version is resolved server-side from the active row, not taken from the
//     request body. A stale/forged version cannot create a junk acceptance.
//   - Unique (user_id, eula_version) index makes re-accept a safe no-op.

const db = require('./lib/db');
const crypto = require('crypto');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  // Hard reject impersonation. The acceptance must come from the real user.
  if (auth.impersonated_by_user_id) {
    return res.status(403).json({ error: 'Cannot accept the agreement while signed in as another user.', code: 'IMPERSONATION_BLOCKED' });
  }

  try {
    const av = await db.query(
      `SELECT version FROM eula_versions WHERE active = TRUE LIMIT 1`
    );
    const active = av.rows[0] || null;
    if (!active) {
      return res.status(409).json({ error: 'No active agreement to accept.', code: 'NO_ACTIVE_VERSION' });
    }

    const id = 'eulaacc-' + crypto.randomBytes(10).toString('hex');
    const ip = getIp(req);
    const ua = req.headers['user-agent'] || null;

    // Idempotent: unique (user_id, eula_version) means a repeat accept is a
    // no-op rather than a duplicate row.
    await db.query(
      `INSERT INTO eula_acceptances (id, subaccount_id, user_id, eula_version, accepted_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6)
       ON CONFLICT (user_id, eula_version) DO NOTHING`,
      [id, auth.subaccount_id, auth.user_id, active.version, ip, ua]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.eula.accept',
      targetType: 'eula_version',
      targetId: active.version,
      targetSubaccountId: auth.subaccount_id,
      metadata: { version: active.version }
    });

    return res.status(200).json({ success: true, version: active.version });
  } catch (e) {
    console.error('eula-accept error:', e.message);
    return res.status(500).json({ error: 'Failed to record acceptance: ' + e.message });
  }
}

exports.handler = wrap(handler);
