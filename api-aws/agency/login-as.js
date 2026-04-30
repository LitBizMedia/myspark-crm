// api/agency/login-as.js (Lambda version)
//
// POST /api/agency/login-as
//
// Server-side validation and audit logging for agency login-as-subaccount.
// HIPAA-critical event. Logs actor, target, and timestamp.
//
// MIGRATED: Supabase REST → lib/db.js for agency_users and subaccounts lookups.

const db = require('./lib/db');
const { logAudit } = require('./lib/audit');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

const ALLOWED_ROLES = ['super_admin', 'admin', 'support'];

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAgencyAuth(req, res);
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
    // Step 1: Validate the agency user
    let user = null;

    if (actor.id === 'agency-admin-primary' && ALLOWED_ROLES.includes(actor.role)) {
      user = {
        id:       actor.id,
        username: actor.username || 'admin',
        name:     actor.username || 'Admin',
        role:     actor.role || 'super_admin'
      };
    } else {
      try {
        const u = await db.findOne('agency_users',
          { id: actor.id, active: true },
          { select: 'id, username, name, role' }
        );
        
        if (!u) {
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
        user = u;
      } catch (e) {
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

    // Step 2: Validate the target subaccount
    const subId = 'sub-' + slug;
    let subName = null;
    let subActive = null;
    
    try {
      const sub = await db.findOne('subaccounts',
        { id: subId },
        { select: 'id, name, active' }
      );
      if (sub) {
        subName = sub.name;
        subActive = sub.active;
      }
    } catch (e) {
      // Continue with subName=null check below
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

    // Step 3: Log success and return
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
}

exports.handler = wrap(handler);
