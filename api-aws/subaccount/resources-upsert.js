// POST /api/subaccount/resources-upsert
// Creates or updates a resource for the authed subaccount.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_TYPES = ['room', 'equipment', 'other'];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    if (!b.id || !b.name || !String(b.name).trim()) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    const type = ALLOWED_TYPES.includes(b.type) ? b.type : 'room';
    const capacity = Math.max(1, parseInt(b.capacity) || 1);
    const bufferAfter = Math.max(0, parseInt(b.buffer_after) || 0);
    const active = b.active !== false;
    const displayOrder = b.display_order != null ? parseInt(b.display_order) : null;
    const notes = b.notes ? String(b.notes).trim() : null;

    await db.query(
      `INSERT INTO resources (id, subaccount_id, name, type, capacity, buffer_after,
                              active, display_order, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         capacity = EXCLUDED.capacity,
         buffer_after = EXCLUDED.buffer_after,
         active = EXCLUDED.active,
         display_order = EXCLUDED.display_order,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       WHERE resources.subaccount_id = $2`,
      [b.id, auth.subaccount_id, String(b.name).trim(), type, capacity, bufferAfter,
       active, displayOrder, notes]
    );

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.resource.upsert',
      targetType: 'resource', targetId: b.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: b.name, type, capacity, active }
    });

    return res.status(200).json({ success: true, id: b.id });
  } catch (e) {
    console.error('resources-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save resource' });
  }
}
exports.handler = wrap(handler);
