// api/agency/login-as-exchange.js
//
// POST /api/agency/login-as-exchange
//
// Consumes a single-use token from agency_login_as_tokens, validates it,
// then mints a real subaccount session and sets the HttpOnly session cookie
// scoped to .mysparkplus.app. The new cookie OVERWRITES any existing
// subaccount session cookie in the browser.
//
// Why this exists: previously, the agency login-as flow used a localStorage
// token and never minted a server-side session for the target. The browser
// kept using the agency user's previously-set subaccount cookie (if any),
// causing cross-tenant data display. This endpoint fixes that by minting
// a proper session bound to the target subaccount's admin user.
//
// Security:
//   - Token must exist, be unused, not expired
//   - Token target_slug must match the slug in the request body
//   - Token marks used_at on consume (atomic UPDATE...WHERE used_at IS NULL)
//   - Target subaccount must still be active
//   - Target admin user must still be active
//   - Every outcome is audited

const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const {
  createSession,
  buildSessionCookie,
  getIpFromReq,
  getUserAgent
} = require('./lib/subaccount-auth');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, slug } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!slug)  return res.status(400).json({ error: 'slug required' });

  try {
    // Step 1: Atomically consume the token (only if unused and not expired).
    // The RETURNING clause gives us back the row we consumed; if no row was
    // affected, the token was invalid (wrong, used, or expired).
    const consumeRes = await db.query(
      `UPDATE agency_login_as_tokens
       SET used_at = NOW()
       WHERE token = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING agency_user_id, agency_username,
                 target_sub_id, target_slug, target_user_id`,
      [token]
    );

    if (!consumeRes.rows.length) {
      await logAudit({
        req,
        actorType: 'agency',
        actorId: 'unknown',
        actorUsername: 'unknown',
        action: 'agency.login_as.exchange',
        targetType: 'subaccount',
        outcome: 'failure',
        errorMessage: 'Invalid, used, or expired token',
        metadata: { slug: slug }
      });
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    const tok = consumeRes.rows[0];

    // Step 2: Slug in request body must match the slug the token was minted for.
    // Prevents an attacker who obtained a token for one subaccount from
    // exchanging it to gain access to another.
    if (tok.target_slug !== slug) {
      await logAudit({
        req,
        actorType: 'agency',
        actorId: tok.agency_user_id,
        actorUsername: tok.agency_username,
        action: 'agency.login_as.exchange',
        targetType: 'subaccount',
        targetId: tok.target_sub_id,
        targetSubaccountId: tok.target_sub_id,
        outcome: 'denied',
        errorMessage: 'Slug mismatch',
        metadata: { requested_slug: slug, token_slug: tok.target_slug }
      });
      return res.status(403).json({ error: 'Slug mismatch' });
    }

    // Step 3: Re-verify target subaccount and admin user are still valid
    const sub = await db.findOne('subaccounts',
      { id: tok.target_sub_id },
      { select: 'id, name, active' }
    );
    if (!sub || sub.active === false) {
      await logAudit({
        req,
        actorType: 'agency',
        actorId: tok.agency_user_id,
        actorUsername: tok.agency_username,
        action: 'agency.login_as.exchange',
        targetType: 'subaccount',
        targetId: tok.target_sub_id,
        targetSubaccountId: tok.target_sub_id,
        outcome: 'failure',
        errorMessage: 'Subaccount missing or inactive at exchange time',
        metadata: { slug: slug }
      });
      return res.status(403).json({ error: 'Subaccount unavailable' });
    }

    const targetUserRes = await db.query(
      `SELECT id, username, display_name, role, active
       FROM subaccount_users
       WHERE id = $1 AND subaccount_id = $2`,
      [tok.target_user_id, tok.target_sub_id]
    );
    if (!targetUserRes.rows.length || targetUserRes.rows[0].active === false) {
      await logAudit({
        req,
        actorType: 'agency',
        actorId: tok.agency_user_id,
        actorUsername: tok.agency_username,
        action: 'agency.login_as.exchange',
        targetType: 'subaccount',
        targetId: tok.target_sub_id,
        targetSubaccountId: tok.target_sub_id,
        outcome: 'failure',
        errorMessage: 'Target user missing or inactive at exchange time',
        metadata: { slug: slug, target_user_id: tok.target_user_id }
      });
      return res.status(403).json({ error: 'Target admin unavailable' });
    }

    const targetUser = targetUserRes.rows[0];

    // Step 4: Mint real subaccount session.
    // Impersonation columns capture the agency admin who initiated the
    // login-as, so every subsequent audit_log row attributes the action to
    // BOTH the target user (actor_*) and the agency admin (impersonated_by_*).
    // HIPAA Right of Access: the real human accountable for every PHI touch.
    // Login-as sessions get a short 1-hour TTL, not the 30-day default, because
    // impersonation is the highest-privilege action and deserves the shortest leash.
    const IMPERSONATION_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
    const sessionInfo = await createSession({
      userId:       targetUser.id,
      userType:     'subaccount',
      subaccountId: tok.target_sub_id,
      username:     targetUser.username,
      displayName:  targetUser.display_name || targetUser.username,
      role:         targetUser.role,
      ipAddress:    getIpFromReq(req),
      userAgent:    getUserAgent(req),
      impersonatedByUserId:   tok.agency_user_id,
      impersonatedByUsername: tok.agency_username,
      impersonatedByUserType: 'subaccount',  // Phase 3: LitBiz agency admin is a subaccount user
      ttlMs: IMPERSONATION_SESSION_TTL_MS    // Short 1h leash for impersonation sessions
    });

    // Step 5: Deliver the session to the new tab. Two flows:
    //   - cookie (default): Set-Cookie overwrites the browser's existing
    //     subaccount session. Used by the legacy /agency portal flow.
    //   - bearer: return token in body, no cookie set. Used by the new
    //     agency-impersonation tab flow so the original tab's cookie
    //     session stays intact.
    const flow = (req.body && req.body.flow === 'bearer') ? 'bearer' : 'cookie';
    if (flow === 'cookie') {
      res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.token, { maxAgeMs: IMPERSONATION_SESSION_TTL_MS }));
    }

    // Step 6: Audit log success
    await logAudit({
      req,
      actorType: 'agency',
      actorId: tok.agency_user_id,
      actorUsername: tok.agency_username,
      action: 'agency.login_as.exchange',
      targetType: 'subaccount',
      targetId: tok.target_sub_id,
      targetSubaccountId: tok.target_sub_id,
      metadata: {
        slug: slug,
        target_name: sub.name,
        target_user_id: targetUser.id,
        target_username: targetUser.username,
        session_expires_at: sessionInfo.expiresAt,
        flow: flow
      }
    });

    const responseBody = {
      success: true,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        name: targetUser.display_name || targetUser.username,
        role: targetUser.role,
        agencyView: true
      },
      subaccount: {
        id: sub.id,
        name: sub.name,
        slug: slug
      },
      expires_at: sessionInfo.expiresAt
    };
    if (flow === 'bearer') {
      responseBody.session_token = sessionInfo.token;
    }
    return res.status(200).json(responseBody);

  } catch (e) {
    console.error('login-as-exchange error:', e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

exports.handler = wrap(handler);
