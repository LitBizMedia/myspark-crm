// api-aws/subaccount/contracts-archive.js
//
// Archive or unarchive an envelope. Archived envelopes hide from default
// view but are preserved as legal records.
//
// Route: POST /api/subaccount/contracts/archive
// Body:  { envelope_id, action: 'archive' | 'unarchive' }

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const contracts = require('./lib/contracts');

async function handler(req, res){
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if ((req.method || '').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const envelopeId = body.envelope_id;
  const action = body.action || 'archive';

  if (!envelopeId) {
    return res.status(400).json({ error: 'envelope_id required' });
  }
  if (action !== 'archive' && action !== 'unarchive') {
    return res.status(400).json({ error: 'action must be archive or unarchive' });
  }

  const subaccountId = auth.subaccount_id;
  const existing = await contracts.getEnvelope(subaccountId, envelopeId);
  if (!existing) {
    return res.status(404).json({ error: 'Envelope not found' });
  }

  let result;
  if (action === 'archive') {
    result = await contracts.archiveEnvelope(subaccountId, envelopeId, auth.user_id);
  } else {
    result = await contracts.unarchiveEnvelope(subaccountId, envelopeId);
  }

  if (!result) {
    return res.status(500).json({ error: 'Operation failed' });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract.' + action,
    targetType: 'contract_envelope',
    targetId: envelopeId,
    targetSubaccountId: subaccountId,
    metadata: { previous_status: existing.status }
  });

  return res.status(200).json({ ok: true, envelope: result });
}

exports.handler = wrap(handler);
