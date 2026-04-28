// api/agency/delete-subaccount.js
//
// Manual subaccount deletion from the agency dashboard.
// Uses the shared lib/subaccount-lifecycle.js helper for the actual deletion.
// Super_admin role required - this is irreversible.
//
// Request body: { subaccountId, slugConfirmation }
// slugConfirmation must match the subaccount's slug exactly. The frontend
// makes the user type it. This is the safety friction layer to prevent
// accidental deletions from misclicks.

const { requireAgencyAuth } = require('../../lib/require-subaccount-auth');
const { deleteSubaccount } = require('../../lib/subaccount-lifecycle');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require super_admin - deletion is irreversible
  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return; // 401/403 already sent

  const { subaccountId, slugConfirmation } = req.body || {};
  if (!subaccountId) {
    return res.status(400).json({ error: 'subaccountId required' });
  }
  if (!slugConfirmation || typeof slugConfirmation !== 'string') {
    return res.status(400).json({ error: 'Slug confirmation required' });
  }

  // Verify slug matches before any work happens. This prevents the case where
  // an agency admin clicks delete on the wrong row - frontend asks for the slug,
  // server verifies it. No destructive action without slug match.
  let actualSlug = null;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + encodeURIComponent(subaccountId) + '&select=slug',
      { headers: sbHeaders() }
    );
    if (!r.ok) return res.status(500).json({ error: 'Failed to verify subaccount: ' + await r.text() });
    const rows = await r.json();
    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Subaccount not found' });
    }
    actualSlug = rows[0].slug;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify subaccount: ' + e.message });
  }

  if (slugConfirmation !== actualSlug) {
    // Audit the failed slug-confirmation attempt - someone tried to delete
    // something but typed the wrong slug, worth seeing in the audit trail
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

  // Slug verified, hand off to lifecycle helper
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
};
