// POST /api/subaccount/contact-allergy-update
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_SEVERITY = ['mild', 'moderate', 'severe'];
const ALLOWED_FIELDS = ['allergen', 'reaction', 'severity', 'notes'];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const id = b.id;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const sets = [];
    const params = [id, auth.subaccount_id];
    let p = 3;

    for (const field of ALLOWED_FIELDS) {
      if (!(field in b)) continue;
      let value = b[field];

      if (field === 'severity') {
        if (!ALLOWED_SEVERITY.includes(value)) {
          return res.status(400).json({ error: 'severity must be one of mild, moderate, severe' });
        }
      } else if (field === 'allergen') {
        value = String(value || '').trim();
        if (!value) return res.status(400).json({ error: 'allergen cannot be empty' });
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        value = trimmed || null;
      }

      sets.push(`${field} = $${p++}`);
      params.push(value);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    sets.push(`updated_at = NOW()`);
    sets.push(`updated_by = $${p}`);
    params.push(auth.user_id);

    const r = await db.query(
      `UPDATE contact_allergies SET ${sets.join(', ')} WHERE id = $1 AND subaccount_id = $2 RETURNING id, contact_id, severity`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Allergy not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_allergy.update',
      targetType: 'contact_allergy', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: r.rows[0].contact_id, severity: r.rows[0].severity }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-allergy-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update allergy' });
  }
}
exports.handler = wrap(handler);
