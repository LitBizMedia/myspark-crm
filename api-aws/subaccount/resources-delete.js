// POST /api/subaccount/resources-delete
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const id = (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const r = await db.query(
      `DELETE FROM resources WHERE id = $1 AND subaccount_id = $2 RETURNING id, name`,
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Resource not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.resource.delete',
      targetType: 'resource', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: r.rows[0].name }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('resources-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete resource' });
  }
}
exports.handler = wrap(handler);
