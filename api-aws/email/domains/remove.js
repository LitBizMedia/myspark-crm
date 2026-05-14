// POST /api/email/domains/remove
//
// Removes BOTH sending and inbound SES identities for a domain, takes the inbound
// subdomain off the SES receipt rule, and deletes the DB row.
//
// Body: { domainId }
//
// Returns: { removed: true }

const db = require('./lib/db');
const { SESv2Client, DeleteEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { SESClient: SESv1Client, DescribeReceiptRuleCommand, UpdateReceiptRuleCommand } = require('@aws-sdk/client-ses');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const SES_REGION = process.env.AWS_REGION || 'us-east-2';
const INBOUND_RULE_SET = 'myspark-inbound-ruleset';
const INBOUND_RULE_NAME = 'catch-reply-subdomain';

const sesV2 = new SESv2Client({ region: SES_REGION });
const sesV1 = new SESv1Client({ region: SES_REGION });

// Best-effort SES identity delete. Swallow NotFound so retries are safe.
async function deleteSESIdentity(domain) {
  try {
    await sesV2.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    return { deleted: true };
  } catch (e) {
    if (e.name === 'NotFoundException') return { deleted: false, reason: 'not found' };
    throw e;
  }
}

// Remove a recipient from the catch-reply rule, idempotent.
async function removeInboundRecipient(inboundDomain) {
  const rule = await sesV1.send(new DescribeReceiptRuleCommand({
    RuleSetName: INBOUND_RULE_SET,
    RuleName: INBOUND_RULE_NAME
  }));
  const current = rule.Rule.Recipients || [];
  if (current.indexOf(inboundDomain) === -1) {
    return { removed: false, reason: 'not in list' };
  }
  const updated = current.filter(function(r) { return r !== inboundDomain; });
  // Receipt rule must always have at least one recipient. If empty, leave a placeholder
  // for the shared default (reply.mysparkplus.app) to keep the rule valid.
  if (updated.length === 0) updated.push('reply.mysparkplus.app');
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
  return { removed: true };
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
    const rowQ = await db.query(
      `SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2`,
      [domainId, subaccountId]
    );
    if (!rowQ.rows.length) return res.status(404).json({ error: 'Domain not found' });
    const row = rowQ.rows[0];

    const domain = row.domain;
    const inboundDomain = (row.inbound_subdomain || 'reply') + '.' + domain;

    const sendingDelete = await deleteSESIdentity(domain);
    const inboundDelete = await deleteSESIdentity(inboundDomain);

    let receiptRuleUpdate = null;
    try {
      receiptRuleUpdate = await removeInboundRecipient(inboundDomain);
    } catch (e) {
      console.error('Failed to update receipt rule:', e.message);
      receiptRuleUpdate = { removed: false, error: e.message };
    }

    await db.query(
      `DELETE FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2`,
      [domainId, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.remove',
      targetType: 'email_domain',
      targetId: domain,
      targetSubaccountId: subaccountId,
      metadata: {
        domain,
        sending_delete: sendingDelete,
        inbound_delete: inboundDelete,
        receipt_rule_update: receiptRuleUpdate
      }
    });

    return res.status(200).json({
      removed: true,
      sending_delete: sendingDelete,
      inbound_delete: inboundDelete,
      receipt_rule_update: receiptRuleUpdate
    });
  } catch (err) {
    console.error('domains/remove error:', err);
    return res.status(500).json({ error: err.message || 'Failed to remove domain' });
  }
}

exports.handler = wrap(handler);
