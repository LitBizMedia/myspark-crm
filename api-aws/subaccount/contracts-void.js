// api-aws/subaccount/contracts-void.js
//
// Action Lambda: voids a sent or viewed envelope.
// Signed envelopes cannot be voided (legal record, immutable).
//
// Route: POST /api/subaccount/contracts/void
// Body:  { envelope_id, reason? }

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const contracts = require('./lib/contracts');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if ((req.method || '').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const envelopeId = body.envelope_id;
  const reason = (body.reason || '').toString().trim() || null;

  if (!envelopeId) {
    return res.status(400).json({ error: 'envelope_id required' });
  }

  const subaccountId = auth.subaccount_id;

  // Fetch first to provide clear error if not found vs wrong status
  const existing = await contracts.getEnvelope(subaccountId, envelopeId);
  if (!existing) {
    return res.status(404).json({ error: 'Envelope not found' });
  }

  if (existing.status === 'signed') {
    return res.status(400).json({ error: 'Signed envelopes cannot be voided. They are legal records.' });
  }
  if (existing.status === 'expired') {
    return res.status(400).json({ error: 'Envelope already expired' });
  }
  if (existing.status === 'voided') {
    return res.status(400).json({ error: 'Envelope already voided' });
  }

  const previousStatus = existing.status;
  const voided = await contracts.voidEnvelope(subaccountId, envelopeId, auth.user_id, reason);

  if (!voided) {
    return res.status(409).json({ error: 'Envelope could not be voided. State may have changed.' });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract.void',
    targetType: 'contract_envelope',
    targetId: envelopeId,
    targetSubaccountId: subaccountId,
    metadata: {
      status_before: previousStatus,
      status_after: 'voided',
      void_reason: reason,
      recipient_email: existing.recipientEmail
    }
  });

  return res.status(200).json({
    ok: true,
    envelope: voided
  });
}

exports.handler = wrap(handler);
