// api/email/domains/inbound-verify.js (Lambda)
//
// POST /api/subaccount/email-domain/inbound-verify
//
// Performs a DNS MX lookup on <inbound_subdomain>.<domain> and confirms the
// MX record matches the stored inbound_mx_target. On match:
//   - inbound_status = 'verified'
//   - inbound_verified_at = NOW()
//
// On mismatch or missing record, returns a diagnostic response without
// changing status (so the caller can retry after DNS propagation).

const dns = require('dns').promises;
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function normalizeMx(value) {
  if (!value) return '';
  return String(value).toLowerCase().replace(/\.$/, '').trim();
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin'] });
  if (!auth) return;
  const subaccountId = auth.subaccount_id;
  const userId = auth.user_id;
  const username = auth.username;
  const role = auth.role;

  const body = req.body || {};
  const { domainId } = body;
  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  // Fetch the domain row with inbound config
  const domain = await db.findOne('subaccount_email_domains',
    { id: domainId },
    { select: 'id, subaccount_id, domain, status, inbound_subdomain, inbound_mx_target, inbound_status' }
  );
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  if (domain.subaccount_id !== subaccountId) return res.status(403).json({ error: 'Forbidden' });
  if (!domain.inbound_mx_target || !domain.inbound_subdomain) {
    return res.status(400).json({ error: 'Run inbound-setup first to configure the MX target' });
  }

  const expected = normalizeMx(domain.inbound_mx_target);
  const lookupHost = domain.inbound_subdomain + '.' + domain.domain;

  let mxRecords = null;
  let lookupError = null;
  try {
    mxRecords = await dns.resolveMx(lookupHost);
  } catch (e) {
    lookupError = e.code || e.message || 'lookup_failed';
  }

  if (lookupError || !mxRecords || mxRecords.length === 0) {
    await logAudit({
      req,
      actorType: auth.user_type || 'subaccount',
      actorId: userId,
      actorUsername: username,
      actorRole: role,
      targetSubaccountId: subaccountId,
      action: 'subaccount.email.inbound.verify_failed',
      targetType: 'email_domain',
      targetId: domainId,
      outcome: 'failure',
      metadata: { lookup_host: lookupHost, error: lookupError || 'no_mx_records' }
    });
    return res.status(200).json({
      ok: false,
      verified: false,
      lookup_host: lookupHost,
      expected_mx: expected,
      found: [],
      error: lookupError || 'no MX records found',
      hint: 'DNS may not have propagated yet. Wait a few minutes and try again.'
    });
  }

  const found = mxRecords.map(r => ({
    exchange: normalizeMx(r.exchange),
    priority: r.priority
  }));
  const match = found.some(r => r.exchange === expected);

  if (!match) {
    await logAudit({
      req,
      actorType: auth.user_type || 'subaccount',
      actorId: userId,
      actorUsername: username,
      actorRole: role,
      targetSubaccountId: subaccountId,
      action: 'subaccount.email.inbound.verify_failed',
      targetType: 'email_domain',
      targetId: domainId,
      outcome: 'failure',
      metadata: { lookup_host: lookupHost, expected, found }
    });
    return res.status(200).json({
      ok: false,
      verified: false,
      lookup_host: lookupHost,
      expected_mx: expected,
      found,
      error: 'MX record does not match expected target'
    });
  }

  // Match. Update status.
  await db.update('subaccount_email_domains', {
    inbound_status: 'verified',
    inbound_verified_at: new Date().toISOString()
  }, { id: domainId });

  await logAudit({
    req,
    actorType: 'subaccount_user',
    actorId: userId,
    targetSubaccountId: subaccountId,
    action: 'subaccount.email.inbound.verified',
    targetType: 'email_domain',
    targetId: domainId,
    metadata: { lookup_host: lookupHost, mx_target: expected }
  });

  return res.status(200).json({
    ok: true,
    verified: true,
    lookup_host: lookupHost,
    expected_mx: expected,
    found,
    inbound_status: 'verified'
  });
}

exports.handler = wrap(handler);
