// api/cron/purge-audit-log.js
// Monthly cron that purges audit_log entries older than 6 years and 1 month.
// HIPAA Security Rule requires audit log retention of 6 years from the date
// of creation (or last effective date, whichever is later). The extra month
// buffer protects against edge cases at the retention boundary.
//
// Vercel cron schedule: "0 4 1 * *" - runs at 4:00 AM UTC on the 1st of each month.
// Add to vercel.json crons array.
//
// Auth: Vercel cron triggers send a special header. We also accept a manual
// trigger with the CRON_SECRET bearer token for testing.

const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// HIPAA retention: 6 years + 1 month buffer
const RETENTION_MONTHS = 73;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function isAuthorized(req) {
  // Vercel cron sends this header internally
  if (req.headers['x-vercel-cron']) return true;
  // Manual trigger via bearer token
  const auth = req.headers.authorization || '';
  if (CRON_SECRET && auth === 'Bearer ' + CRON_SECRET) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const cutoffIso = cutoff.toISOString();

  try {
    // First count what we are about to delete (for the audit entry)
    const countRes = await fetch(
      SUPABASE_URL + '/rest/v1/audit_log?created_at=lt.' + encodeURIComponent(cutoffIso) + '&select=id',
      { headers: sbHeaders({ 'Prefer': 'count=exact' }) }
    );

    let purgeCount = 0;
    if (countRes.ok) {
      const contentRange = countRes.headers.get('content-range') || '';
      const totalStr = contentRange.split('/')[1] || '0';
      purgeCount = parseInt(totalStr) || 0;
    }

    if (purgeCount === 0) {
      // Still write a "checked, nothing to do" audit entry monthly so the cron's
      // execution itself is logged. Helps prove retention policy is being applied.
      await logAudit({
        actorType: 'system',
        actorUsername: 'cron-purge-audit-log',
        action: 'system.audit_log.purge_check',
        metadata: {
          retention_months: RETENTION_MONTHS,
          cutoff: cutoffIso,
          entries_purged: 0,
          run_at: new Date().toISOString()
        }
      });
      return res.status(200).json({ success: true, purged: 0, cutoff: cutoffIso });
    }

    // Delete the old entries
    const deleteRes = await fetch(
      SUPABASE_URL + '/rest/v1/audit_log?created_at=lt.' + encodeURIComponent(cutoffIso),
      { method: 'DELETE', headers: sbHeaders() }
    );

    if (!deleteRes.ok) {
      const errText = await deleteRes.text();
      await logAudit({
        actorType: 'system',
        actorUsername: 'cron-purge-audit-log',
        action: 'system.audit_log.purge',
        outcome: 'failure',
        errorMessage: 'Delete failed: ' + errText,
        metadata: {
          retention_months: RETENTION_MONTHS,
          cutoff: cutoffIso,
          attempted_count: purgeCount
        }
      });
      return res.status(500).json({ error: 'Purge failed', detail: errText });
    }

    // Log the successful purge. This entry itself is subject to retention later.
    await logAudit({
      actorType: 'system',
      actorUsername: 'cron-purge-audit-log',
      action: 'system.audit_log.purge',
      metadata: {
        retention_months: RETENTION_MONTHS,
        cutoff: cutoffIso,
        entries_purged: purgeCount,
        run_at: new Date().toISOString()
      }
    });

    return res.status(200).json({
      success: true,
      purged: purgeCount,
      cutoff: cutoffIso
    });

  } catch (e) {
    console.error('purge-audit-log error:', e);
    return res.status(500).json({ error: 'Purge failed', detail: e.message });
  }
};
