// api/agency/login-as.js
//
// POST /api/agency/login-as
//
// Validates agency permission to act on a target subaccount, resolves the
// target subaccount's primary admin user, and mints a single-use token
// stored in agency_login_as_tokens. The frontend then opens a new tab and
// POSTs the token to /api/agency/login-as-exchange to mint a real
// subaccount session cookie.
//
// HIPAA-critical event. Both this endpoint and the exchange endpoint log
// to audit_log with action 'agency.login_as.start' and 'agency.login_as.exchange'.
//
// Rewritten May 13, 2026 to replace the broken localStorage-based token
// flow that never minted a server-side subaccount session.

const crypto = require('crypto');
const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

const ALLOWED_ROLES = ['super_admin', 'admin', 'support'];
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getIpFromReq(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    null
  );
}

function getUserAgent(req) {
  return req.headers['user-agent'] || null;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { slug } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const actor = {
    id:       auth.user_id,
    username: auth.username,
    role:     auth.role,
    name:     auth.display_name || auth.username
  };

  try {
    // Step 1: Resolve calling user. Three possible sources:
    //   1. LitBiz workspace agency admin (subaccount_users with is_agency_admin=true).
    //      requireAgencyAdmin sets auth.is_agency_admin and returns the subaccount
    //      session. These users are already vetted by the 3-layer gate; no
    //      secondary agency_users lookup needed. Treated as super_admin equivalent.
    //   2. Legacy break-glass agency super_admin (auth.id === 'agency-admin-primary').
    //   3. Regular agency_users row from /agency portal login.
    let user = null;
    if (auth.is_agency_admin === true && auth.user_type === 'subaccount') {
      // Source 1: LitBiz workspace agency admin
      user = {
        id:       actor.id,
        username: actor.username,
        name:     actor.name,
        role:     'super_admin'
      };
    } else if (actor.id === 'agency-admin-primary' && ALLOWED_ROLES.includes(actor.role)) {
      // Source 2: legacy break-glass agency primary
      user = {
        id:       actor.id,
        username: actor.username || 'admin',
        name:     actor.username || 'Admin',
        role:     actor.role || 'super_admin'
      };
    } else {
      // Source 3: regular agency_users row (from /agency portal session)
      const u = await db.findOne('agency_users',
        { id: actor.id, active: true },
        { select: 'id, username, name, role' }
      );
      if (!u) {
        await logAudit({
          req, actorType: 'agency_admin', actorId: actor.id, actorUsername: actor.username,
          action: 'agency.login_as.start', targetType: 'subaccount',
          outcome: 'denied', errorMessage: 'Agency user not found or inactive',
          metadata: { target_slug: slug }
        });
        return res.status(403).json({ error: 'Not authorized' });
      }
      user = u;
    }

    if (!ALLOWED_ROLES.includes(user.role)) {
      await logAudit({
        req, actorType: 'agency_admin', actorId: user.id, actorUsername: user.username,
        actorRole: user.role, action: 'agency.login_as.start', targetType: 'subaccount',
        outcome: 'denied', errorMessage: 'Role does not permit login-as',
        metadata: { target_slug: slug }
      });
      return res.status(403).json({ error: 'Insufficient permission' });
    }

    // Step 2: Resolve target subaccount
    const subId = 'sub-' + slug;
    const sub = await db.findOne('subaccounts',
      { id: subId },
      { select: 'id, name, active' }
    );

    if (!sub) {
      await logAudit({
        req, actorType: 'agency_admin', actorId: user.id, actorUsername: user.username,
        actorRole: user.role, action: 'agency.login_as.start',
        targetType: 'subaccount', targetId: subId, targetSubaccountId: subId,
        outcome: 'failure', errorMessage: 'Subaccount not found',
        metadata: { target_slug: slug }
      });
      return res.status(404).json({ error: 'Subaccount not found' });
    }

    if (sub.active === false) {
      await logAudit({
        req, actorType: 'agency_admin', actorId: user.id, actorUsername: user.username,
        actorRole: user.role, action: 'agency.login_as.start',
        targetType: 'subaccount', targetId: subId, targetSubaccountId: subId,
        outcome: 'denied', errorMessage: 'Subaccount is inactive',
        metadata: { target_slug: slug }
      });
      return res.status(403).json({ error: 'Subaccount is inactive' });
    }

    // Step 3: Resolve target admin user in subaccount_users.
    // Strategy: pick the oldest active admin in the target subaccount.
    // This mirrors how getEffectiveAdmin works on the frontend.
    const targetUserRes = await db.query(
      `SELECT id, username, display_name, role
       FROM subaccount_users
       WHERE subaccount_id = $1 AND active = true AND role = 'admin'
       ORDER BY created_at ASC
       LIMIT 1`,
      [subId]
    );

    if (!targetUserRes.rows.length) {
      await logAudit({
        req, actorType: 'agency_admin', actorId: user.id, actorUsername: user.username,
        actorRole: user.role, action: 'agency.login_as.start',
        targetType: 'subaccount', targetId: subId, targetSubaccountId: subId,
        outcome: 'failure',
        errorMessage: 'Target subaccount has no active admin user',
        metadata: { target_slug: slug, target_name: sub.name }
      });
      return res.status(404).json({ error: 'Subaccount has no admin user to log in as' });
    }

    const targetUser = targetUserRes.rows[0];

    // Step 4: Mint single-use token
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    await db.query(
      `INSERT INTO agency_login_as_tokens
        (token, agency_user_id, agency_username, target_sub_id, target_slug,
         target_user_id, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        token, user.id, user.username, subId, slug,
        targetUser.id, expiresAt,
        getIpFromReq(req), getUserAgent(req)
      ]
    );

    // Step 5: Audit log success
    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      action: 'agency.login_as.start',
      targetType: 'subaccount',
      targetId: subId,
      targetSubaccountId: subId,
      metadata: {
        target_slug: slug,
        target_name: sub.name,
        target_user_id: targetUser.id,
        target_username: targetUser.username,
        token_expires_at: expiresAt
      }
    });

    return res.status(200).json({
      success: true,
      token: token,
      target: {
        id: subId,
        name: sub.name,
        slug: slug,
        active: sub.active
      },
      expires_at: expiresAt
    });

  } catch (e) {
    console.error('login-as error:', e);
    await logAudit({
      req, actorType: 'agency_admin', actorId: actor.id, actorUsername: actor.username,
      action: 'agency.login_as.start', targetType: 'subaccount',
      outcome: 'failure', errorMessage: e.message,
      metadata: { target_slug: slug }
    });
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

exports.handler = wrap(handler);
