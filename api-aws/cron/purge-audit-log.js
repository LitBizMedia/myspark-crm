// api/cron/purge-audit-log.js (Lambda version - Secrets Manager)
//
// Monthly cron that purges audit_log entries older than 6 years and 1 month.
// HIPAA Security Rule §164.312 requires 6-year audit log retention.
//
// AWS schedule: EventBridge Scheduler → Lambda invocation (no auth needed)
// Schedule expression: cron(0 4 1 * ? *)  (4:00 AM UTC on the 1st of each month)
//
// CREDENTIALS: CRON_SECRET (for HTTP testing path) loaded from Secrets Manager.

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const RETENTION_MONTHS = 73;

async function getCronSecret() {
  return secrets.getKey('myspark/cron/secret', 'CRON_SECRET');
}

async function runPurge(triggerSource) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const cutoffIso = cutoff.toISOString();

  try {
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE created_at < $1`,
      [cutoffIso]
    );
    const purgeCount = countResult.rows[0].n;

    if (purgeCount === 0) {
      await logAudit({
        actorType: 'system',
        actorUsername: 'cron-purge-audit-log',
        action: 'system.audit_log.purge_check',
        metadata: {
          retention_months: RETENTION_MONTHS,
          cutoff: cutoffIso,
          entries_purged: 0,
          run_at: new Date().toISOString(),
          trigger_source: triggerSource
        }
      });
      return { success: true, purged: 0, cutoff: cutoffIso };
    }

    await db.query(
      `DELETE FROM audit_log WHERE created_at < $1`,
      [cutoffIso]
    );

    await logAudit({
      actorType: 'system',
      actorUsername: 'cron-purge-audit-log',
      action: 'system.audit_log.purge',
      metadata: {
        retention_months: RETENTION_MONTHS,
        cutoff: cutoffIso,
        entries_purged: purgeCount,
        run_at: new Date().toISOString(),
        trigger_source: triggerSource
      }
    });

    return { success: true, purged: purgeCount, cutoff: cutoffIso };

  } catch (e) {
    console.error('purge-audit-log error:', e);
    await logAudit({
      actorType: 'system',
      actorUsername: 'cron-purge-audit-log',
      action: 'system.audit_log.purge',
      outcome: 'failure',
      errorMessage: e.message,
      metadata: {
        retention_months: RETENTION_MONTHS,
        cutoff: cutoffIso,
        trigger_source: triggerSource
      }
    });
    throw e;
  }
}

async function httpHandler(req, res) {
  const auth = req.headers.authorization || '';
  const cronSecret = await getCronSecret();
  if (!cronSecret || auth !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPurge('http');
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Purge failed', detail: e.message });
  }
}

const httpWrapped = wrap(httpHandler);

exports.handler = async function (event, context) {
  const isEventBridge = event && event.source && event.source.startsWith('aws.');
  const isScheduledEvent = event && (event['detail-type'] === 'Scheduled Event' || event.source === 'aws.scheduler');
  
  if (isEventBridge || isScheduledEvent) {
    try {
      return await runPurge('eventbridge');
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  
  return httpWrapped(event, context);
};
