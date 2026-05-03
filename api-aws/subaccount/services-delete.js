// POST /api/subaccount/services-delete
// Cascade-deletes service_variations and class_sessions tied to the service,
// then deletes the service itself. Order matters: children first, parent last,
// so a partial failure cannot orphan child rows.
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
    // 1. Verify the service exists in this subaccount.
    const svcCheck = await db.query(
      'SELECT id, name FROM services WHERE id=$1 AND subaccount_id=$2',
      [id, subaccountId]
    );
    if (svcCheck.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const serviceName = svcCheck.rows[0].name;

    // 2. Collect class_session ids for audit (so we know what got cascade-deleted).
    const sessRows = await db.query(
      'SELECT id, title FROM class_sessions WHERE service_id=$1 AND subaccount_id=$2',
      [id, subaccountId]
    );
    const sessions = sessRows.rows;

    // 3. Collect variation ids for audit.
    const varRows = await db.query(
      'SELECT id, name FROM service_variations WHERE service_id=$1',
      [id]
    );
    const variations = varRows.rows;

    // 4. Delete class sessions first (single atomic statement).
    if (sessions.length > 0) {
      await db.query(
        'DELETE FROM class_sessions WHERE service_id=$1 AND subaccount_id=$2',
        [id, subaccountId]
      );
    }

    // 5. Delete service variations (single atomic statement).
    if (variations.length > 0) {
      await db.query(
        'DELETE FROM service_variations WHERE service_id=$1',
        [id]
      );
    }

    // 6. Delete the service itself.
    const r = await db.query(
      'DELETE FROM services WHERE id=$1 AND subaccount_id=$2 RETURNING id',
      [id, subaccountId]
    );
    if (r.rows.length === 0) {
      // Should not happen given the check above, but guard anyway.
      return res.status(404).json({ error: 'Service vanished mid-delete' });
    }

    // 7. Audit the cascade. One entry for the service, one per cascade target type.
    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action:'subaccount.service.delete', targetType:'service',
      targetId:id, targetSubaccountId:subaccountId,
      metadata:{
        service_name: serviceName,
        cascaded_class_sessions: sessions.length,
        cascaded_variations: variations.length,
        cascaded_session_ids: sessions.map(s => s.id),
        cascaded_variation_ids: variations.map(v => v.id)
      }
    });

    return res.status(200).json({
      success: true,
      id,
      cascaded: {
        class_sessions: sessions.length,
        variations: variations.length
      }
    });
  } catch(e) {
    console.error('services-delete error:', e.message);
    return res.status(500).json({ error:'Failed to delete service' });
  }
}
exports.handler = wrap(handler);
