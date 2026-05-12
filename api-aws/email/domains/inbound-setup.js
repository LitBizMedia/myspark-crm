// api/email/domains/inbound-setup.js (Lambda)
//
// POST /api/subaccount/email-domain/inbound-setup
//
// Stores the inbound configuration for a verified domain:
//   - inbound_subdomain (e.g. 'reply' → reply.clinic.com)
//   - inbound_mx_target (provided by Resend dashboard after Inbound toggle)
//   - inbound_status     'pending'
//
// NOTE: Resend does not expose inbound-enable via API. The agency owner must
// toggle "Receiving" in the Resend dashboard for the domain, copy the MX
// target Resend reveals, and pass it to this endpoint. Subaccount then adds
// the MX record to DNS, then calls inbound-verify.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const DEFAULT_INBOUND_SUBDOMAIN = 'reply';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin'] });
  if (!auth) return;
  const subaccountId = auth.subaccount_id;
  const userId = auth.user_id;
  const username = auth.username;
  const role = auth.role;

  const body = req.body || {};
  const { domainId, mxTarget, inboundSubdomain } = body;

  if (!domainId)  return res.status(400).json({ error: 'domainId required' });
  if (!mxTarget)  return res.status(400).json({ error: 'mxTarget required (copy from Resend dashboard after enabling Inbound)' });

  // Basic validation on mxTarget (hostname-ish)
  if (typeof mxTarget !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(mxTarget)) {
    return res.status(400).json({ error: 'mxTarget looks invalid' });
  }

  const sub = (inboundSubdomain || DEFAULT_INBOUND_SUBDOMAIN).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(sub)) {
    return res.status(400).json({ error: 'inboundSubdomain must be lowercase letters, numbers, hyphens' });
  }

  // Verify domain belongs to this subaccount and is verified outbound
  const domain = await db.findOne('subaccount_email_domains',
    { id: domainId },
    { select: 'id, subaccount_id, domain, status' }
  );
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.subaccount_id !== subaccountId) return res.status(403).json({ error: 'Forbidden' });
  if (domain.status !== 'verified') {
    return res.status(400).json({ error: 'Outbound domain must be verified before configuring inbound' });
  }

  // Persist inbound configuration
  await db.update('subaccount_email_domains', {
    inbound_subdomain: sub,
    inbound_mx_target: mxTarget,
    inbound_status: 'pending',
    inbound_verified_at: null
  }, { id: domainId });

  await logAudit({
    req,
    actorType: auth.user_type || 'subaccount',
    actorId: userId,
    actorUsername: username,
    actorRole: role,
    targetSubaccountId: subaccountId,
    action: 'subaccount.email.inbound.setup',
    targetType: 'email_domain',
    targetId: domainId,
    metadata: { inbound_subdomain: sub, inbound_mx_target: mxTarget, domain: domain.domain }
  });

  return res.status(200).json({
    ok: true,
    inbound_subdomain: sub,
    inbound_mx_target: mxTarget,
    inbound_status: 'pending',
    instructions: {
      mx_host: sub + '.' + domain.domain,
      mx_value: mxTarget,
      mx_priority: 10,
      next_step: 'Add the MX record to your DNS provider, then call /api/subaccount/email-domain/inbound-verify'
    }
  });
}

exports.handler = wrap(handler);
