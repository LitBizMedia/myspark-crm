// api-aws/subaccount/contracts-delete.js
//
// Hard-delete a contract envelope. GUARDED: only 'voided' or 'draft' envelopes
// can be deleted. Signed/sent/viewed/expired contracts are legal records and
// must be archived instead. Tenant-isolated, audit-logged.
//
// Route: POST /api/subaccount/contracts/delete
// Body:  { envelope_id }

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
  if (!envelopeId) {
    return res.status(400).json({ error: 'envelope_id required' });
  }

  const subaccountId = auth.subaccount_id;
  const existing = await contracts.getEnvelope(subaccountId, envelopeId);
  if (!existing) {
    return res.status(404).json({ error: 'Envelope not found' });
  }

  let deleted;
  try {
    deleted = await contracts.deleteEnvelope(subaccountId, envelopeId);
  } catch (e) {
    if (e.code === 'PROTECTED_STATUS') {
      return res.status(403).json({
        error: 'Only voided or draft contracts can be deleted. Signed contracts must be archived.',
        status: e.status
      });
    }
    console.error('contracts-delete error:', e.message);
    return res.status(500).json({ error: 'Delete failed' });
  }

  if (!deleted) {
    return res.status(404).json({ error: 'Envelope not found' });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract.delete',
    targetType: 'contract_envelope',
    targetId: envelopeId,
    targetSubaccountId: subaccountId,
    metadata: { deleted_status: deleted.status }
  });

  return res.status(200).json({ ok: true, deleted: envelopeId });
}

exports.handler = wrap(handler);
