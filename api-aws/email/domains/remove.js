// api/email/domains/remove.js (Lambda version)
//
// POST /api/email/domains/remove
//
// Deletes the domain from Mailgun and from our DB. Subaccount returns to
// shared sending mode with a fresh 14-day grace period.
//
// Body: { domainId }
//
// Returns: { removed: true }
//
// MIGRATION: SES → Mailgun (May 18, 2026)

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const MAILGUN_SECRET_NAME = 'myspark/integrations/mailgun';

// Best-effort Mailgun domain delete. Swallow NotFound so retries are safe.
// Delete a Mailgun route by ID. Idempotent: missing routes are not an error.
async function deleteMailgunRoute(routeId, apiKey) {
  if (!routeId) return { deleted: false, reason: 'no_route_id' };
  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const url = 'https://api.mailgun.net/v3/routes/' + encodeURIComponent(routeId);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Basic ' + auth }
  });

  if (response.status === 404) return { deleted: false, reason: 'not_found_in_mailgun' };
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }
    throw new Error('Mailgun routes API ' + response.status + ': ' + (body.message || 'unknown error'));
  }
  return { deleted: true };
}

async function deleteMailgunDomain(domain, apiKey) {
  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const url = 'https://api.mailgun.net/v4/domains/' + encodeURIComponent(domain);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Basic ' + auth }
  });

  if (response.status === 404) {
    return { deleted: false, reason: 'not_found_in_mailgun' };
  }
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }
    throw new Error('Mailgun API ' + response.status + ': ' + (body.message || 'unknown error'));
  }
  return { deleted: true };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { domainId } = req.body || {};
  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Get the row first (so we know the domain name for Mailgun cleanup)
    const r = await db.query(
      'SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2',
      [domainId, subaccountId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Domain not found' });
    const row = r.rows[0];

    // Try Mailgun cleanup (best-effort, don't fail the whole op if Mailgun doesn't have it)
    let mailgunResult = { domain_deleted: false, route_deleted: false };
    if (row.domain) {
      try {
        const apiKey = await secrets.getKey(MAILGUN_SECRET_NAME, 'MAILGUN_ACCOUNT_API_KEY');

        // Delete the Mailgun route first (must exist to delete the domain too)
        try {
          const routeResult = await deleteMailgunRoute(row.mailgun_inbound_route_id, apiKey);
          mailgunResult.route_deleted = routeResult.deleted;
        } catch (e) {
          console.warn('email-domains-remove: route delete failed:', e.message);
          mailgunResult.route_error = e.message;
        }

        // Then delete the domain
        const domainResult = await deleteMailgunDomain(row.domain, apiKey);
        mailgunResult.domain_deleted = domainResult.deleted;
      } catch (e) {
        console.warn('email-domains-remove: Mailgun delete failed:', e.message);
        mailgunResult.error = e.message;
      }
    }

    // Delete the DB row (this restarts the grace period when subaccount next loads)
    await db.query(
      'DELETE FROM subaccount_email_domains WHERE id = $1',
      [domainId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.remove',
      targetType: 'email_domain',
      targetId: domainId,
      targetSubaccountId: subaccountId,
      metadata: {
        domain: row.domain,
        mailgun_result: mailgunResult
      }
    });

    return res.status(200).json({
      removed: true,
      mailgun_result: mailgunResult
    });

  } catch (e) {
    console.error('email-domains-remove error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to remove domain' });
  }
}

exports.handler = wrap(handler);
