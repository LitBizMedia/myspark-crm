// api/agency/login-as.js
// Server-side validation and audit logging for agency login-as-subaccount.
//
// HIPAA-critical event: this is when an agency staff member begins viewing
// a client's PHI. Must be logged with actor, target, and timestamp.
//
// Validates:
//   1. The agency user exists and is active
//   2. The agency user has a role that permits login-as
//   3. The target subaccount exists
//
// On success, logs agency.login_as.start and returns ok. The frontend then
// generates the session token and opens the workspace tab as before.

const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ROLES = ['super_admin', 'admin', 'support'];

function sbHeaders() {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug, actor } = req.body || {};
  if (!slug)            return res.status(400).json({ error: 'slug required' });
  if (!actor || !actor.id) return res.status(400).json({ error: 'actor.id required' });

  try {
    // ─────────────────────────────────────────
    // Step 1: Validate the agency user
    // ─────────────────────────────────────────
    let user = null;

    // Special case: the disaster-recovery fallback admin uses a synthetic ID
    if (actor.id === 'agency-admin-primary' && ALLOWED_ROLES.includes(actor.role)) {
      user = {
        id:       actor.id,
        username: actor.username || 'admin',
        name:     actor.username || 'Admin',
        role:     actor.role || 'super_admin'
      };
    } else {
      const userRes = await fetch(
        SUPABASE_URL + '/rest/v1/agency_users'
          + '?id=eq.' + encodeURIComponent(actor.id)
          + '&active=eq.true'
          + '&select=id,username,name,role',
        { headers: sbHeaders() }
      );

      if (!userRes.ok) {
        await logAudit({
          req,
          actorType:     'agency',
          actorId:       actor.id,
          actorUsername: actor.username,
          action:        'agency.login_as.start',
          targetType:    'subaccount',
          outcome:       'failure',
          errorMessage:  'Could not verify agency user (DB error)',
          metadata:      { target_slug: slug }
        });
        return res.status(500).json({ error: 'Could not verify user' });
      }

      const users = await userRes.json();
      if (!users || !users.length) {
        await logAudit({
          req,
          actorType:     'agency',
          actorId:       actor.id,
          actorUsername: actor.username,
          action:        'agency.login_as.start',
          targetType:    'subaccount',
          outcome:       'denied',
          errorMessage:  'Agency user not found or inactive',
          metadata:      { target_slug: slug }
        });
        return res.status(403).json({ error: 'Not authorized' });
      }

      user = users[0];
    }

    if (!ALLOWED_ROLES.includes(user.role)) {
      await logAudit({
        req,
        actorType:     'agency',
        actorId:       user.id,
        actorUsername: user.username,
        actorRole:     user.role,
        action:        'agency.login_as.start',
        targetType:    'subaccount',
        outcome:       'denied',
        errorMessage:  'Role does not permit login-as',
        metadata:      { target_slug: slug }
      });
      return res.status(403).json({ error: 'Insufficient permission' });
    }

    // ─────────────────────────────────────────
    // Step 2: Validate the target subaccount exists
    // ─────────────────────────────────────────
    const subId = 'sub-' + slug;
    const subRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts'
        + '?id=eq.' + encodeURIComponent(subId)
        + '&select=id,name,active',
      { headers: sbHeaders() }
    );

    let subName = null;
    let subActive = null;
    if (subRes.ok) {
      const subRows = await subRes.json();
      if (subRows && subRows.length) {
        subName = subRows[0].name;
        subActive = subRows[0].active;
      }
    }

    if (subName === null) {
      await logAudit({
        req,
        actorType:           'agency',
        actorId:             user.id,
        actorUsername:       user.username,
        actorRole:           user.role,
        action:              'agency.login_as.start',
        targetType:          'subaccount',
        targetId:            subId,
        targetSubaccountId:  subId,
        outcome:             'failure',
        errorMessage:        'Subaccount not found',
        metadata:            { target_slug: slug }
      });
      return res.status(404).json({ error: 'Subaccount not found' });
    }

    // ─────────────────────────────────────────
    // Step 3: Log success and return
    // ─────────────────────────────────────────
    await logAudit({
      req,
      actorType:           'agency',
      actorId:             user.id,
      actorUsername:       user.username,
      actorRole:           user.role,
      action:              'agency.login_as.start',
      targetType:          'subaccount',
      targetId:            subId,
      targetSubaccountId:  subId,
      metadata: {
        target_slug:   slug,
        target_name:   subName,
        target_active: subActive
      }
    });

    return res.status(200).json({
      success: true,
      target: { id: subId, name: subName, active: subActive }
    });

  } catch (e) {
    console.error('login-as error:', e);
    await logAudit({
      req,
      actorType:     'agency',
      actorId:       actor.id,
      actorUsername: actor.username,
      action:        'agency.login_as.start',
      targetType:    'subaccount',
      outcome:       'failure',
      errorMessage:  e.message,
      metadata:      { target_slug: slug }
    });
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
};
