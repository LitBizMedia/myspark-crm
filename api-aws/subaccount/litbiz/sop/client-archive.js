// DELETE /api/subaccount/litbiz/sop/clients/:id
// Soft delete via archived = true.

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');

async function handler(req, res) {
  try {
    if (req.method !== 'DELETE') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    const params = req.pathParameters || {};
    const id = params.id;
    if (!id) return res.status(400).json({ error: 'id_required' });

    const result = await db.query(
      `UPDATE litbiz_sop_clients
         SET archived = TRUE, updated_at = NOW()
         WHERE id = $1 AND subaccount_id = $2 AND archived = FALSE
         RETURNING id, name`,
      [id, auth.subaccount_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'client_not_found' });
    }

    const row = result.rows[0];

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.litbiz.sop.client.archive',
      targetType: 'litbiz_sop_client',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: row.name }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('sop-client-archive error:', e.message);
    return res.status(500).json({ error: 'client_archive_failed' });
  }
}

exports.handler = wrap(handler);
