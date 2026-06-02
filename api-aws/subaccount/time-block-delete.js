// POST /api/subaccount/time-block-delete
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
      `DELETE FROM time_blocks WHERE id = $1 AND subaccount_id = $2 RETURNING id, staff_id, block_date`,
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Time block not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.time_block.delete',
      targetType: 'time_block', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { staff_id: r.rows[0].staff_id }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('time-block-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete time block' });
  }
}
exports.handler = wrap(handler);
