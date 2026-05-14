// POST /api/email/domains/verify
//
// Checks SES verification status for BOTH sending and inbound identities.
// When inbound is newly verified, automatically adds the inbound subdomain to
// the SES receipt rule recipients list.
//
// Body: { slug, domainId }  (domainId is the row id, not the domain string)
//
// Returns: { domain: {...db row...}, sending_status, inbound_status }

const db = require('./lib/db');
const { SESv2Client, GetEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { SESClient: SESv1Client, DescribeReceiptRuleCommand, UpdateReceiptRuleCommand } = require('@aws-sdk/client-ses');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const SES_REGION = process.env.AWS_REGION || 'us-east-2';
const INBOUND_RULE_SET = 'myspark-inbound-ruleset';
const INBOUND_RULE_NAME = 'catch-reply-subdomain';

const sesV2 = new SESv2Client({ region: SES_REGION });
const sesV1 = new SESv1Client({ region: SES_REGION });

async function getIdentityStatus(domain) {
  try {
    const got = await sesV2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      exists: true,
      verified: !!got.VerifiedForSendingStatus,
      dkim_status: (got.DkimAttributes && got.DkimAttributes.Status) || 'NOT_STARTED'
    };
  } catch (e) {
    if (e.name === 'NotFoundException') {
      return { exists: false, verified: false, dkim_status: 'NOT_STARTED' };
    }
    throw e;
  }
}

// Add an inbound recipient domain to the catch-reply rule's recipients list.
// Idempotent: if already present, no-op.
async function addInboundRecipient(inboundDomain) {
  const rule = await sesV1.send(new DescribeReceiptRuleCommand({
    RuleSetName: INBOUND_RULE_SET,
    RuleName: INBOUND_RULE_NAME
  }));
  const current = rule.Rule.Recipients || [];
  if (current.indexOf(inboundDomain) !== -1) {
    return { added: false, reason: 'already present' };
  }
  const updated = current.concat([inboundDomain]);
  await sesV1.send(new UpdateReceiptRuleCommand({
    RuleSetName: INBOUND_RULE_SET,
    Rule: {
      Name: rule.Rule.Name,
      Enabled: rule.Rule.Enabled,
      TlsPolicy: rule.Rule.TlsPolicy,
      Recipients: updated,
      Actions: rule.Rule.Actions,
      ScanEnabled: rule.Rule.ScanEnabled
    }
  }));
  return { added: true };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const domainId = body.domainId;

  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  try {
    // Load existing row, scoped to subaccount
    const rowQ = await db.query(
      `SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2`,
      [domainId, subaccountId]
    );
    if (!rowQ.rows.length) return res.status(404).json({ error: 'Domain not found' });
    const row = rowQ.rows[0];

    const domain = row.domain;
    const inboundDomain = (row.inbound_subdomain || 'reply') + '.' + domain;

    const sending = await getIdentityStatus(domain);
    const inbound = await getIdentityStatus(inboundDomain);

    const sendingStatus = sending.verified ? 'verified' : 'pending';
    const inboundStatus = inbound.verified ? 'verified' : 'pending';

    // If inbound newly became verified, add it to the receipt rule
    let receiptRuleUpdate = null;
    if (inboundStatus === 'verified' && row.inbound_status !== 'verified') {
      try {
        receiptRuleUpdate = await addInboundRecipient(inboundDomain);
      } catch (e) {
        console.error('Failed to update receipt rule:', e.message);
        receiptRuleUpdate = { added: false, error: e.message };
      }
    }

    // Update DB row to reflect current state
    const now = new Date().toISOString();
    const updates = {};
    if (sendingStatus !== row.status) updates.status = sendingStatus;
    if (inboundStatus !== row.inbound_status) updates.inbound_status = inboundStatus;
    if (sendingStatus === 'verified' && !row.verified_at) updates.verified_at = now;
    if (inboundStatus === 'verified' && !row.inbound_verified_at) updates.inbound_verified_at = now;

    if (Object.keys(updates).length) {
      const setClause = Object.keys(updates)
        .map(function(k, i) { return k + ' = $' + (i + 1); })
        .join(', ');
      const vals = Object.values(updates).concat([domainId, subaccountId]);
      await db.query(
        `UPDATE subaccount_email_domains SET ${setClause}
         WHERE id = $${vals.length - 1} AND subaccount_id = $${vals.length}`,
        vals
      );
    }

    // Fetch fresh row
    const fresh = await db.query(
      `SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2`,
      [domainId, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.verify',
      targetType: 'email_domain',
      targetId: domain,
      targetSubaccountId: subaccountId,
      metadata: {
        domain,
        sending_status: sendingStatus,
        inbound_status: inboundStatus,
        sending_dkim: sending.dkim_status,
        inbound_dkim: inbound.dkim_status,
        receipt_rule_update: receiptRuleUpdate
      }
    });

    return res.status(200).json({
      domain: fresh.rows[0],
      sending_status: sendingStatus,
      inbound_status: inboundStatus,
      sending_dkim: sending.dkim_status,
      inbound_dkim: inbound.dkim_status,
      receipt_rule_update: receiptRuleUpdate
    });
  } catch (err) {
    console.error('domains/verify error:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify domain' });
  }
}

exports.handler = wrap(handler);
