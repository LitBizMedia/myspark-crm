// POST /api/subaccount/service-variations-delete
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      'DELETE FROM service_variations WHERE id=$1 AND subaccount_id=$2 RETURNING id',
      [id, subaccountId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action:'subaccount.service_variation.delete', targetType:'service_variation',
      targetId:id, targetSubaccountId:subaccountId, metadata:{}
    });

    return res.status(200).json({ success:true, id });
  } catch(e) {
    console.error('service-variations-delete error:', e.message);
    return res.status(500).json({ error:'Failed to delete variation' });
  }
}
exports.handler = wrap(handler);
