// api-aws/subaccount/contracts-envelopes.js
//
// REST resource Lambda for contract envelopes (sent contracts).
// Single Lambda, dispatches on method + id presence (per hybrid pattern).
//
// Routes (one API Gateway route, ANY method):
//   GET    /api/subaccount/contracts/envelopes              list, optional ?status= and ?contact_id=
//   GET    /api/subaccount/contracts/envelopes?id=          get one (with ?counts=1 returns status counts)

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const contracts = require('./lib/contracts');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if ((req.method || '').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = req.query || {};
  const id = q.id || null;
  const wantCounts = q.counts === '1' || q.counts === 'true';

  const subaccountId = auth.subaccount_id;

  try {
    if (id) {
      const env = await contracts.getEnvelope(subaccountId, id);
      if (!env) return res.status(404).json({ error: 'Envelope not found' });

      await logAudit({
        req,
        actorType: 'subaccount',
        actorId: auth.user_id,
        actorUsername: auth.username,
        actorRole: auth.role,
        action: 'subaccount.contract.view',
        targetType: 'contract_envelope',
        targetId: id,
        targetSubaccountId: subaccountId
      });

      return res.status(200).json({ envelope: env });
    }

    // List path
    const status = q.status || null;
    const contactId = q.contact_id || null;
    const limit = Math.min(parseInt(q.limit, 10) || 100, 200);
    const offset = parseInt(q.offset, 10) || 0;

    const list = await contracts.listEnvelopes(subaccountId, {
      status, contactId, limit, offset
    });

    let counts = null;
    if (wantCounts) {
      counts = await contracts.getEnvelopeStatusCounts(subaccountId);
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contract.list',
      targetType: 'contract_envelope',
      targetSubaccountId: subaccountId,
      metadata: { count: list.length, filter_status: status, filter_contact_id: contactId }
    });

    return res.status(200).json({
      envelopes: list,
      counts: counts
    });

  } catch (e) {
    console.error('contracts-envelopes error:', e);
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}

exports.handler = wrap(handler);
