// POST /api/subaccount/contact-allergy-create
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const crypto = require('crypto');

const ALLOWED_SEVERITY = ['mild', 'moderate', 'severe'];

function uid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function hashAllergen(s) {
  return crypto.createHash('sha256').update(String(s || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const contactId = b.contact_id;
    const allergen = b.allergen ? String(b.allergen).trim() : '';
    const severity = b.severity;
    const reaction = b.reaction ? String(b.reaction).trim() : null;
    const notes = b.notes ? String(b.notes).trim() : null;

    if (!contactId) return res.status(400).json({ error: 'contact_id is required' });
    if (!allergen) return res.status(400).json({ error: 'allergen is required' });
    if (!ALLOWED_SEVERITY.includes(severity)) {
      return res.status(400).json({ error: 'severity must be one of mild, moderate, severe' });
    }

    const c = await db.query(
      `SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2`,
      [contactId, auth.subaccount_id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const id = uid();
    await db.query(
      `INSERT INTO contact_allergies (id, contact_id, subaccount_id, allergen, reaction, severity, notes, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NOW(), $8)`,
      [id, contactId, auth.subaccount_id, allergen, reaction, severity, notes, auth.user_id]
    );

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_allergy.create',
      targetType: 'contact_allergy', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: contactId, severity, allergen_hash: hashAllergen(allergen) }
    });

    return res.status(200).json({
      success: true,
      id,
      allergy: {
        id, contact_id: contactId, allergen, reaction, severity, notes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('contact-allergy-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create allergy' });
  }
}
exports.handler = wrap(handler);
