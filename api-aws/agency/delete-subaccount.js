// api/agency/delete-subaccount.js (Lambda version)
//
// POST /api/agency/delete-subaccount
//
// Manual subaccount deletion from the agency dashboard.
// Super_admin role required. Slug confirmation required.
//
// MIGRATED: Supabase REST → lib/db.js for slug verification.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { deleteSubaccount } = require('./lib/subaccount-lifecycle');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { subaccountId, slugConfirmation } = req.body || {};
  if (!subaccountId) {
    return res.status(400).json({ error: 'subaccountId required' });
  }
  if (!slugConfirmation || typeof slugConfirmation !== 'string') {
    return res.status(400).json({ error: 'Slug confirmation required' });
  }

  // Verify slug matches before any work happens.
  let actualSlug = null;
  try {
    const sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'slug' }
    );
    if (!sub) {
      return res.status(404).json({ error: 'Subaccount not found' });
    }
    actualSlug = sub.slug;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify subaccount: ' + e.message });
  }

  if (slugConfirmation !== actualSlug) {
    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.subaccount.delete',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'denied',
      errorMessage: 'Slug confirmation did not match',
      metadata: { reason: 'manual', provided_slug: slugConfirmation, expected_slug: actualSlug }
    });
    return res.status(400).json({ error: 'Slug confirmation does not match. Type the exact slug to confirm deletion.' });
  }

  // Slug verified - hand off to lifecycle helper
  const result = await deleteSubaccount(subaccountId, {
    req: req,
    actor: {
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role
    },
    actionName: 'agency.subaccount.delete',
    reason: 'manual'
  });

  if (!result.success) {
    const status = result.code === 'NOT_FOUND' ? 404
                 : result.code === 'PROTECTED' ? 403
                 : 500;
    return res.status(status).json({
      error: result.error,
      code: result.code,
      cleanup_results: result.cleanup_results
    });
  }

  return res.status(200).json({
    success: true,
    partial: !!result.partial,
    cleanup_results: result.cleanup_results
  });
}

exports.handler = wrap(handler);
