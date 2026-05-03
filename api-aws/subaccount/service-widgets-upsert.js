// POST /api/subaccount/service-widgets-upsert
// Creates or updates a single service_widgets row scoped to the caller's subaccount.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const w = req.body || {};
  if (!w.id || typeof w.id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!w.name || typeof w.name !== 'string' || !w.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (w.service_ids != null && !Array.isArray(w.service_ids)) {
    return res.status(400).json({ error: 'service_ids must be an array' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    // Determine if new or existing for audit purposes.
    const existing = await db.query(
      'SELECT id FROM service_widgets WHERE id = $1 AND subaccount_id = $2',
      [w.id, subaccountId]
    );
    const isNew = existing.rows.length === 0;

    await db.query(`
      INSERT INTO service_widgets (
        id, subaccount_id, name, service_ids, primary_color, logo_url, tagline, active,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        service_ids = EXCLUDED.service_ids,
        primary_color = EXCLUDED.primary_color,
        logo_url = EXCLUDED.logo_url,
        tagline = EXCLUDED.tagline,
        active = EXCLUDED.active,
        updated_at = NOW()
      WHERE service_widgets.subaccount_id = $2
    `, [
      w.id, subaccountId, w.name.trim(),
      JSON.stringify(w.service_ids || []),
      w.primary_color || '#6b21ea',
      w.logo_url || null,
      w.tagline || null,
      w.active !== false
    ]);

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: isNew ? 'subaccount.service_widget.create' : 'subaccount.service_widget.update',
      targetType: 'service_widget', targetId: w.id,
      targetSubaccountId: subaccountId,
      metadata: { name: w.name, service_count: (w.service_ids || []).length, active: w.active !== false }
    });

    // Return the full row so frontend can refresh local state if desired.
    const fresh = await db.query(
      'SELECT * FROM service_widgets WHERE id = $1 AND subaccount_id = $2',
      [w.id, subaccountId]
    );
    return res.status(200).json({ success: true, widget: fresh.rows[0] });
  } catch (e) {
    console.error('service-widgets-upsert error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to save widget' });
  }
}

exports.handler = wrap(handler);
