// POST /api/subaccount/contact-create
// Creates a new contact for the authed subaccount.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function uid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};

    const firstName = safeStr(b.first_name);
    const lastName = safeStr(b.last_name);
    let displayName = safeStr(b.display_name) || safeStr(b.name);
    if (!displayName) {
      displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
    }
    if (!displayName) {
      return res.status(400).json({ error: 'display_name, first_name+last_name, or name is required' });
    }

    const id = safeStr(b.id) || uid();
    const email = safeStr(b.email);
    const phone = safeStr(b.phone);
    // Defensive: if date_of_birth doesn't match YYYY-MM-DD or has a clearly
    // bogus year, null it instead of letting Postgres reject the whole row.
    let dob = safeStr(b.date_of_birth);
    if (dob) {
      const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) {
        dob = null;
      } else {
        const y = parseInt(m[1], 10);
        if (y < 1900 || y > new Date().getUTCFullYear()) dob = null;
      }
    }

    const externalId = safeStr(b.external_id);

    await db.query(
      `INSERT INTO contacts (
        id, subaccount_id, external_id,
        first_name, last_name, display_name,
        email, phone, company, title, website,
        date_of_birth, gender, pronouns, preferred_language,
        address_line1, address_line2, city, state, postal_code, country, timezone,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
        source, type, status, archived,
        tags, custom_field_values,
        square_customer_id, square_cards,
        created_at, updated_at, created_by, updated_by
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22,
        $23, $24, $25,
        $26, $27, $28, $29,
        $30, $31,
        $32, $33,
        NOW(), NOW(), $34, $34
      )`,
      [
        id, auth.subaccount_id, externalId,
        firstName, lastName, displayName,
        email, phone, safeStr(b.company), safeStr(b.title), safeStr(b.website),
        dob, safeStr(b.gender), safeStr(b.pronouns), safeStr(b.preferred_language),
        safeStr(b.address_line1), safeStr(b.address_line2), safeStr(b.city), safeStr(b.state),
        safeStr(b.postal_code), safeStr(b.country) || 'US', safeStr(b.timezone),
        safeStr(b.emergency_contact_name), safeStr(b.emergency_contact_phone), safeStr(b.emergency_contact_relationship),
        safeStr(b.source), safeStr(b.type) || 'client', safeStr(b.status) || 'active', b.archived === true,
        JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
        JSON.stringify(b.custom_field_values && typeof b.custom_field_values === 'object' ? b.custom_field_values : {}),
        safeStr(b.square_customer_id), JSON.stringify(Array.isArray(b.square_cards) ? b.square_cards : []),
        auth.user_id
      ]
    );

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact.create',
      targetType: 'contact', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { display_name: displayName, has_email: !!email, has_phone: !!phone }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-create error:', e.message);
    if (e.code === '23505') {
      if (e.constraint === 'idx_contacts_subaccount_external') {
        return res.status(409).json({ error: 'Contact with this external_id already exists', external_id_conflict: true });
      }
      return res.status(409).json({ error: 'Contact ID already exists' });
    }
    return res.status(500).json({ error: 'Failed to create contact' });
  }
}
exports.handler = wrap(handler);
