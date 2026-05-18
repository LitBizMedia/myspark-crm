// api/email/domains/verify.js (Lambda version)
//
// POST /api/email/domains/verify
//
// Tells Mailgun to verify our DNS records. If all records validate, the domain
// transitions to "active" on Mailgun's side and we mark sending_mode='branded'.
//
// Body: { domainId }
//
// Returns: { domain: {...db row...}, mailgun_state, verified: bool }
//
// MIGRATION: SES → Mailgun (May 18, 2026)

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const MAILGUN_SECRET_NAME = 'myspark/integrations/mailgun';

// Tell Mailgun to verify the domain. Returns the updated domain object.
async function verifyMailgunDomain(domain, apiKey) {
  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const url = 'https://api.mailgun.net/v4/domains/' + encodeURIComponent(domain) + '/verify';

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Basic ' + auth }
  });

  let body;
  try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }

  if (!response.ok) {
    throw new Error('Mailgun API ' + response.status + ': ' + (body.message || 'unknown error'));
  }

  return body;  // { domain: {...with state...}, sending_dns_records, receiving_dns_records }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { domainId } = req.body || {};
  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Get the domain row
    const r = await db.query(
      'SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2',
      [domainId, subaccountId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Domain not found' });
    const row = r.rows[0];

    if (!row.domain) {
      return res.status(400).json({ error: 'Domain row has no domain name' });
    }

    // Get Mailgun API key
    const apiKey = await secrets.getKey(MAILGUN_SECRET_NAME, 'MAILGUN_ACCOUNT_API_KEY');

    // Tell Mailgun to verify
    const mgResult = await verifyMailgunDomain(row.domain, apiKey);
    const mgDomain = mgResult.domain || {};
    const mgState = mgDomain.state || 'unknown';
    const isVerified = mgState === 'active';

    // Refresh DNS records in case Mailgun updated them
    const sendingRecords = mgResult.sending_dns_records || [];
    const receivingRecords = mgResult.receiving_dns_records || [];
    const allRecords = [];
    for (const rec of sendingRecords) {
      allRecords.push({
        type: rec.record_type,
        name: rec.name || row.domain,
        value: rec.value,
        valid: rec.valid,
        purpose: 'sending'
      });
    }
    for (const rec of receivingRecords) {
      allRecords.push({
        type: rec.record_type,
        name: rec.name || row.domain,
        value: rec.value,
        priority: rec.priority || null,
        valid: rec.valid,
        purpose: 'receiving'
      });
    }

    // Preserve any authentication records (DMARC) from the previous state.
    // Mailgun does not return these so we keep them across re-verifies.
    const previousRecords = Array.isArray(row.dkim_records) ? row.dkim_records : [];
    const authRecords = previousRecords.filter(function(r) { return r.purpose === 'authentication'; });
    if (authRecords.length === 0) {
      // Re-add minimal DMARC if missing (e.g., row added before DMARC support)
      allRecords.push({
        type: 'TXT',
        name: '_dmarc.' + row.domain,
        value: 'v=DMARC1; p=none',
        purpose: 'authentication'
      });
    } else {
      for (const r of authRecords) allRecords.push(r);
    }

    // Mailgun's state=active reflects sending readiness only (SPF+DKIM validated).
    // It does NOT require MX records to validate. We track sending and inbound
    // separately, because the customer must add MX records before patient replies work.
    const sendingValid = sendingRecords.length > 0 && sendingRecords.every(function(r) {
      return r.valid === 'valid';
    });
    const inboundValid = receivingRecords.length > 0 && receivingRecords.every(function(r) {
      return r.valid === 'valid';
    });

    const newSendingMode = sendingValid ? 'branded' : 'shared';
    const newInboundMode = inboundValid ? 'branded' : 'shared';
    // status='verified' only when BOTH sending and inbound are fully valid
    const newStatus = (sendingValid && inboundValid) ? 'verified' : 'pending';

    const updates = {
      status: newStatus,
      sending_mode: newSendingMode,
      inbound_mode: newInboundMode,
      dkim_records: JSON.stringify(allRecords),
      verified_at: newStatus === 'verified' ? new Date().toISOString() : null,
      mailgun_domain_id: mgDomain.id || row.mailgun_domain_id
    };

    const updateResult = await db.query(
      `UPDATE subaccount_email_domains
       SET status = $1, sending_mode = $2, inbound_mode = $3, dkim_records = $4,
           verified_at = $5, mailgun_domain_id = $6
       WHERE id = $7
       RETURNING *`,
      [updates.status, updates.sending_mode, updates.inbound_mode, updates.dkim_records,
       updates.verified_at, updates.mailgun_domain_id, domainId]
    );
    const updated = updateResult.rows[0];

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.verify',
      targetType: 'email_domain',
      targetId: domainId,
      targetSubaccountId: subaccountId,
      metadata: {
        domain: row.domain,
        mailgun_state: mgState,
        verified: isVerified
      }
    });

    return res.status(200).json({
      domain: updated,
      mailgun_state: mgState,
      verified: newStatus === 'verified',
      sending_valid: sendingValid,
      inbound_valid: inboundValid
    });

  } catch (e) {
    console.error('email-domains-verify error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to verify domain' });
  }
}

exports.handler = wrap(handler);
