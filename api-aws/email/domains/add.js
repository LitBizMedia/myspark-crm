// POST /api/email/domains/add
//
// Provisions BOTH sending and inbound SES identities in one call:
//   - {domain}: sending identity (DKIM + SPF)
//   - reply.{domain}: inbound identity (DKIM + MX)
//
// Returns the full list of DNS records the customer must add at their DNS provider.
//
// Body: { slug, domain }
//
// Returns: { domain: { ...db row... }, records: [...] }

const db = require('./lib/db');
const { SESv2Client, CreateEmailIdentityCommand, GetEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const SES_REGION = process.env.AWS_REGION || 'us-east-2';
const sesClient = new SESv2Client({ region: SES_REGION });

const INBOUND_SUBDOMAIN = 'reply';
const SES_INBOUND_HOST = 'inbound-smtp.' + SES_REGION + '.amazonaws.com';

// Sanitize a domain string. Reject obvious garbage.
function normalizeDomain(s) {
  if (!s) return null;
  const cleaned = String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  if (!cleaned) return null;
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

// Try to create an SES identity; if it exists, just fetch the existing DKIM tokens.
// This handles the "re-add" case gracefully.
async function ensureSESIdentity(domain) {
  try {
    await sesClient.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
  } catch (e) {
    if (e.name !== 'AlreadyExistsException') {
      throw e;
    }
  }
  // Fetch tokens (whether just-created or pre-existing)
  const got = await sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  const tokens = (got.DkimAttributes && got.DkimAttributes.Tokens) || [];
  const verified = !!got.VerifiedForSendingStatus;
  const dkimStatus = (got.DkimAttributes && got.DkimAttributes.Status) || 'NOT_STARTED';
  return { tokens, verified, dkimStatus };
}

// Build the DNS records the customer needs to add.
// Returns an array of { type, name, value, priority, group, label, description }
function buildDnsRecords(domain, sendingTokens, inboundTokens) {
  const records = [];

  // Sending domain DKIM (3 CNAMEs)
  sendingTokens.forEach(function(token) {
    records.push({
      type: 'CNAME',
      name: token + '._domainkey.' + domain,
      value: token + '.dkim.amazonses.com',
      group: 'sending',
      label: 'DKIM',
      description: 'Allows your domain to sign outbound emails (deliverability)'
    });
  });

  // Sending SPF (TXT). Customer may need to merge with existing SPF.
  records.push({
    type: 'TXT',
    name: domain,
    value: 'v=spf1 include:amazonses.com ~all',
    group: 'sending',
    label: 'SPF',
    description: 'Authorizes AWS SES to send mail for your domain. If you have an existing SPF record, merge the "include:amazonses.com" into it instead of adding a second.'
  });

  // Inbound MX (1 record)
  records.push({
    type: 'MX',
    name: INBOUND_SUBDOMAIN + '.' + domain,
    value: SES_INBOUND_HOST,
    priority: 10,
    group: 'inbound',
    label: 'MX',
    description: 'Routes patient replies to MySpark+ inbox'
  });

  // Inbound DKIM (3 CNAMEs)
  inboundTokens.forEach(function(token) {
    records.push({
      type: 'CNAME',
      name: token + '._domainkey.' + INBOUND_SUBDOMAIN + '.' + domain,
      value: token + '.dkim.amazonses.com',
      group: 'inbound',
      label: 'DKIM',
      description: 'Authenticates incoming replies'
    });
  });

  // DMARC (recommended, not required)
  records.push({
    type: 'TXT',
    name: '_dmarc.' + domain,
    value: 'v=DMARC1; p=none; rua=mailto:dmarc@' + domain + '; fo=1',
    group: 'dmarc',
    label: 'DMARC',
    description: 'Recommended: enables monitoring of who sends mail claiming to be from your domain. Safe starter posture; does not affect delivery.'
  });

  return records;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const domain = normalizeDomain(body.domain);

  if (!domain) return res.status(400).json({ error: 'Invalid domain' });
  if (domain.indexOf(INBOUND_SUBDOMAIN + '.') === 0) {
    return res.status(400).json({ error: 'Use the root domain, not a subdomain' });
  }

  try {
    // Check if a row already exists for this subaccount - one domain per subaccount for now
    const existing = await db.query(
      `SELECT id, domain FROM subaccount_email_domains WHERE subaccount_id = $1`,
      [subaccountId]
    );
    if (existing.rows.length && existing.rows[0].domain !== domain) {
      return res.status(400).json({
        error: 'A different domain (' + existing.rows[0].domain + ') is already configured. Remove it first.'
      });
    }

    // Provision both SES identities (idempotent if they already exist)
    const sending = await ensureSESIdentity(domain);
    const inbound = await ensureSESIdentity(INBOUND_SUBDOMAIN + '.' + domain);

    const records = buildDnsRecords(domain, sending.tokens, inbound.tokens);

    // Status derives from SES verification state
    const sendingStatus = sending.verified ? 'verified' : 'pending';
    const inboundStatus = inbound.verified ? 'verified' : 'pending';

    const now = new Date().toISOString();
    if (existing.rows.length) {
      // Update existing row to reflect newly provisioned identities
      await db.query(
        `UPDATE subaccount_email_domains
         SET status = $1,
             dkim_records = $2,
             spf_record = $3,
             inbound_subdomain = $4,
             inbound_status = $5,
             inbound_mx_target = $6,
             inbound_mode = $7
         WHERE subaccount_id = $8`,
        [
          sendingStatus,
          JSON.stringify(records),
          'v=spf1 include:amazonses.com ~all',
          INBOUND_SUBDOMAIN,
          inboundStatus,
          SES_INBOUND_HOST,
          'branded',
          subaccountId
        ]
      );
    } else {
      // Insert new row. resend_domain_id is NOT NULL so we store a marker.
      await db.query(
        `INSERT INTO subaccount_email_domains (
          subaccount_id, domain, resend_domain_id, status, dkim_records, spf_record,
          inbound_subdomain, inbound_status, inbound_mx_target, inbound_mode, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          subaccountId,
          domain,
          'ses:' + domain,  // legacy column, just a marker for SES-provisioned domains
          sendingStatus,
          JSON.stringify(records),
          'v=spf1 include:amazonses.com ~all',
          INBOUND_SUBDOMAIN,
          inboundStatus,
          SES_INBOUND_HOST,
          'branded',
          now
        ]
      );
    }

    // Fetch the fresh row
    const fresh = await db.query(
      `SELECT * FROM subaccount_email_domains WHERE subaccount_id = $1`,
      [subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.add',
      targetType: 'email_domain',
      targetId: domain,
      targetSubaccountId: subaccountId,
      metadata: {
        domain,
        sending_dkim_tokens: sending.tokens.length,
        inbound_dkim_tokens: inbound.tokens.length,
        sending_status: sendingStatus,
        inbound_status: inboundStatus
      }
    });

    return res.status(200).json({
      domain: fresh.rows[0],
      records
    });
  } catch (err) {
    console.error('domains/add error:', err);
    return res.status(500).json({ error: err.message || 'Failed to add domain' });
  }
}

exports.handler = wrap(handler);
