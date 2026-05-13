// POST /api/subaccount/contact-update
// Updates whitelisted fields on an existing contact.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_FIELDS = [
  'external_id',
  'first_name', 'last_name', 'display_name',
  'email', 'phone', 'company', 'title', 'website',
  'date_of_birth', 'gender', 'pronouns', 'preferred_language',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'timezone',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
  'source', 'type', 'status', 'archived',
  'tags', 'custom_field_values',
  'square_customer_id', 'square_cards'
];

const JSONB_FIELDS = new Set(['tags', 'custom_field_values', 'square_cards']);
const BOOLEAN_FIELDS = new Set(['archived']);

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
    const changedFields = [];

    for (const field of ALLOWED_FIELDS) {
      if (!(field in b)) continue;
      let value = b[field];

      if (JSONB_FIELDS.has(field)) {
        value = JSON.stringify(value == null ? (field === 'custom_field_values' ? {} : []) : value);
      } else if (BOOLEAN_FIELDS.has(field)) {
        value = value === true;
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        value = trimmed || null;
      }

      sets.push(`${field} = $${p}`);
      params.push(value);
      changedFields.push(field);
      p++;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    sets.push(`updated_at = NOW()`);
    sets.push(`updated_by = $${p}`);
    params.push(auth.user_id);

    const sql = `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND subaccount_id = $2 RETURNING id, display_name`;
    const r = await db.query(sql, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Contact not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact.update',
      targetType: 'contact', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { changed_fields: changedFields }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update contact' });
  }
}
exports.handler = wrap(handler);
