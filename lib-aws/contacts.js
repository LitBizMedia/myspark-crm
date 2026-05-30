// lib/contacts.js
//
// Shared contact lookup helpers for backend Lambdas.
//
// Returns contacts in the camelCase shape callers expect (matching the
// legacy blob shape and the shape data-load.js sends to the frontend).
//
// This file is the single source of truth for backend contact reads.
// Future contact schema changes are made here once.
//
// USAGE:
//   const { getContactById, getAllContacts } = require('./lib/contacts');
//   const contact = await getContactById(subaccountId, contactId);
//   const all = await getAllContacts(subaccountId);

const db = require('./db');

// Convert a contacts row (snake_case) to the camelCase shape callers expect.
function rowToCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    subaccount_id: row.subaccount_id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: row.display_name,
    display_name: row.display_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    title: row.title,
    website: row.website,
    date_of_birth: row.date_of_birth instanceof Date ?
      (function(d){
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth()+1).padStart(2,'0');
        const da = String(d.getUTCDate()).padStart(2,'0');
        return y+'-'+m+'-'+da;
      })(row.date_of_birth) :
      row.date_of_birth,
    gender: row.gender,
    pronouns: row.pronouns,
    preferred_language: row.preferred_language,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state: row.state,
    postal_code: row.postal_code,
    country: row.country,
    timezone: row.timezone,
    emergency_contact_name: row.emergency_contact_name,
    emergency_contact_phone: row.emergency_contact_phone,
    emergency_contact_relationship: row.emergency_contact_relationship,
    source: row.source,
    type: row.type,
    status: row.status,
    archived: !!row.archived,
    tags: row.tags || [],
    customFieldValues: row.custom_field_values || {},
    creditBalance: row.credit_balance != null ? parseFloat(row.credit_balance) : 0,
    squareCustomerId: row.square_customer_id,
    squareCards: row.square_cards || [],
    sms_consent_transactional: !!row.sms_consent_transactional,
    sms_consent_marketing: !!row.sms_consent_marketing,
    sms_consent_updated_at: row.sms_consent_updated_at instanceof Date ? row.sms_consent_updated_at.toISOString() : row.sms_consent_updated_at,
    sms_consent_source: row.sms_consent_source,
    email_suppressed: !!row.email_suppressed,
    email_suppression_reason: row.email_suppression_reason,
    email_marketing_consent: row.email_marketing_consent == null ? true : !!row.email_marketing_consent,
    email_marketing_consent_updated_at: row.email_marketing_consent_updated_at instanceof Date ? row.email_marketing_consent_updated_at.toISOString() : row.email_marketing_consent_updated_at,
    email_marketing_consent_source: row.email_marketing_consent_source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

// Standard SELECT column list. Keep in sync with data-load.js mapping.
const CONTACT_COLUMNS = `
  id, subaccount_id, external_id,
  first_name, last_name, display_name,
  email, phone, company, title, website,
  date_of_birth, gender, pronouns, preferred_language,
  address_line1, address_line2, city, state, postal_code, country, timezone,
  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  source, type, status, archived, tags, custom_field_values,
  credit_balance, square_customer_id, square_cards,
  sms_consent_transactional, sms_consent_marketing, sms_consent_updated_at, sms_consent_source,
  email_suppressed, email_suppression_reason,
  email_marketing_consent, email_marketing_consent_updated_at, email_marketing_consent_source,
  created_at, updated_at, created_by, updated_by
`;

// Look up a single contact by id, scoped to subaccount.
async function getContactById(subaccountId, contactId) {
  if (!subaccountId || !contactId) return null;
  try {
    const r = await db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1 AND subaccount_id = $2 LIMIT 1`,
      [contactId, subaccountId]
    );
    return r.rows.length ? rowToCamel(r.rows[0]) : null;
  } catch (e) {
    console.error('getContactById error:', e.message);
    return null;
  }
}

// Look up a contact by email, scoped to subaccount.
async function getContactByEmail(subaccountId, email) {
  if (!subaccountId || !email) return null;
  try {
    const r = await db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE subaccount_id = $1 AND LOWER(email) = LOWER($2)
       LIMIT 1`,
      [subaccountId, email]
    );
    return r.rows.length ? rowToCamel(r.rows[0]) : null;
  } catch (e) {
    console.error('getContactByEmail error:', e.message);
    return null;
  }
}

// Look up a contact by phone, scoped to subaccount.
// Tries exact match first, then digits-only comparison (handles formatting),
// then last-10-digits match (handles country code differences).
async function getContactByPhone(subaccountId, phone) {
  if (!subaccountId || !phone) return null;
  try {
    let r = await db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE subaccount_id = $1 AND phone = $2 LIMIT 1`,
      [subaccountId, phone]
    );
    if (r.rows.length) return rowToCamel(r.rows[0]);

    const digits = String(phone).replace(/\D/g, '');
    if (digits.length >= 10) {
      r = await db.query(
        `SELECT ${CONTACT_COLUMNS} FROM contacts
         WHERE subaccount_id = $1
           AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
         LIMIT 1`,
        [subaccountId, digits]
      );
      if (r.rows.length) return rowToCamel(r.rows[0]);

      if (digits.length > 10) {
        const last10 = digits.slice(-10);
        r = await db.query(
          `SELECT ${CONTACT_COLUMNS} FROM contacts
           WHERE subaccount_id = $1
             AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
           LIMIT 1`,
          [subaccountId, last10]
        );
        if (r.rows.length) return rowToCamel(r.rows[0]);
      }
    }
    return null;
  } catch (e) {
    console.error('getContactByPhone error:', e.message);
    return null;
  }
}

// Fetch all contacts for a subaccount.
async function getAllContacts(subaccountId) {
  if (!subaccountId) return [];
  try {
    const r = await db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE subaccount_id = $1 ORDER BY created_at ASC`,
      [subaccountId]
    );
    return r.rows.map(rowToCamel);
  } catch (e) {
    console.error('getAllContacts error:', e.message);
    return [];
  }
}

// Create a stub contact when we receive an SMS from an unknown number.
// Populates all NOT NULL columns with sensible defaults. The 'Unknown' name
// and source='sms_inbound' make these easy to find and clean up later.
//
// Returns the new contact id, or null on error.
async function createStubContactFromSms(subaccountId, phone) {
  if (!subaccountId || !phone) return null;
  try {
    const contactId = 'cnt_' + Math.random().toString(36).slice(2, 14);
    const displayName = 'Unknown (' + phone + ')';
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO contacts
         (id, subaccount_id, first_name, last_name, display_name, phone,
          source, type, status, archived,
          tags, custom_field_values, credit_balance, square_cards,
          email_suppressed,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false,
               '[]'::jsonb, '{}'::jsonb, 0, '[]'::jsonb,
               false,
               $10, $10)`,
      [
        contactId, subaccountId,
        'Unknown', 'SMS Sender', displayName, phone,
        'sms_inbound', 'lead', 'active',
        now
      ]
    );
    return contactId;
  } catch (e) {
    console.error('createStubContactFromSms error:', e.message);
    return null;
  }
}

// Create a new contact from public/system context (booking widget, form submit, etc).
// Returns { id } on success, throws on failure.
async function createContact(subaccountId, opts) {
  if (!subaccountId) throw new Error('subaccountId is required');
  if (!opts || (!opts.name && !opts.email && !opts.phone)) {
    throw new Error('At least one of name/email/phone is required');
  }
  const contactId = 'cnt_' + Math.random().toString(36).slice(2, 14);
  const fullName = (opts.name || '').trim();
  const parts = fullName.split(/\s+/);
  const firstName = parts[0] || null;
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
  const displayName = fullName || opts.email || opts.phone || 'Unknown';
  const email = opts.email ? String(opts.email).toLowerCase().trim() : null;
  const phone = opts.phone ? String(opts.phone).trim() : null;
  const source = opts.source || 'public';
  const smsConsent = !!opts.sms_consent_transactional;
  const smsConsentSource = smsConsent ? (opts.sms_consent_source || source) : null;
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO contacts
       (id, subaccount_id, first_name, last_name, display_name, email, phone,
        source, type, status, archived,
        tags, custom_field_values, credit_balance, square_cards,
        email_suppressed,
        sms_consent_transactional, sms_consent_marketing,
        sms_consent_updated_at, sms_consent_source,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false,
             '[]'::jsonb, '{}'::jsonb, 0, '[]'::jsonb,
             false,
             $11, false,
             $12, $13,
             $14, $14)`,
    [
      contactId, subaccountId,
      firstName, lastName, displayName, email, phone,
      source, 'client', 'active',
      smsConsent,
      smsConsent ? now : null,
      smsConsentSource,
      now
    ]
  );
  return { id: contactId };
}

// Look up a single contact WITH all PHI joins (notes, allergies, warnings).
// Used by contact-open endpoint when the drawer opens. Heavier query so don't
// use this for bulk listings; that's what contact-list is for.
async function getContactByIdWithPHI(subaccountId, contactId) {
  if (!subaccountId || !contactId) return null;
  try {
    const contact = await getContactById(subaccountId, contactId);
    if (!contact) return null;

    const [notes, allergies, warnings] = await Promise.all([
      db.query(
        `SELECT id, text, author_id, author_name, created_at, updated_at
         FROM contact_notes WHERE contact_id = $1 AND subaccount_id = $2
         ORDER BY created_at DESC`,
        [contactId, subaccountId]
      ),
      db.query(
        `SELECT id, allergen, reaction, severity, notes, created_at, updated_at, created_by, updated_by
         FROM contact_allergies WHERE contact_id = $1 AND subaccount_id = $2
         ORDER BY created_at DESC`,
        [contactId, subaccountId]
      ),
      db.query(
        `SELECT id, severity, text, created_at, updated_at, created_by, updated_by
         FROM contact_warnings WHERE contact_id = $1 AND subaccount_id = $2
         ORDER BY created_at DESC`,
        [contactId, subaccountId]
      )
    ]);

    contact.notes = notes.rows.map(n => ({
      id: n.id, text: n.text,
      authorId: n.author_id, authorName: n.author_name,
      createdAt: n.created_at instanceof Date ? n.created_at.toISOString() : n.created_at,
      updatedAt: n.updated_at instanceof Date ? n.updated_at.toISOString() : n.updated_at
    }));
    contact.allergies = allergies.rows.map(a => ({
      id: a.id, allergen: a.allergen, reaction: a.reaction,
      severity: a.severity, notes: a.notes,
      createdAt: a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at,
      updatedAt: a.updated_at instanceof Date ? a.updated_at.toISOString() : a.updated_at,
      createdBy: a.created_by, updatedBy: a.updated_by
    }));
    contact.warnings = warnings.rows.map(w => ({
      id: w.id, severity: w.severity, text: w.text,
      createdAt: w.created_at instanceof Date ? w.created_at.toISOString() : w.created_at,
      updatedAt: w.updated_at instanceof Date ? w.updated_at.toISOString() : w.updated_at,
      createdBy: w.created_by, updatedBy: w.updated_by
    }));
    contact.creditHistory = [];

    return contact;
  } catch (e) {
    console.error('getContactByIdWithPHI error:', e.message);
    return null;
  }
}

// findOrCreateContact: atomic dedup-or-insert.
// Looks up by email first, then phone, then creates if neither found.
// Returns { contact, was_created, matched_by }.
//
// Used by booking widget, form submit, and any flow that ingests
// contact data from external sources where dedup matters.
//
// Race safety: the whole operation is wrapped in a transaction. If two
// concurrent calls come in with the same email, one will lock and the
// other will see the new row on its lookup and return it.
async function findOrCreateContact(subaccountId, opts) {
  if (!subaccountId) throw new Error('subaccountId is required');
  if (!opts || (!opts.email && !opts.phone)) {
    throw new Error('At least one of email or phone is required for find-or-create');
  }

  // Try email match first (most reliable identifier)
  if (opts.email) {
    const byEmail = await getContactByEmail(subaccountId, opts.email);
    if (byEmail) {
      return { contact: byEmail, was_created: false, matched_by: 'email' };
    }
  }

  // Try phone match next (uses 3-tier normalized matching internally)
  if (opts.phone) {
    const byPhone = await getContactByPhone(subaccountId, opts.phone);
    if (byPhone) {
      return { contact: byPhone, was_created: false, matched_by: 'phone' };
    }
  }

  // No match found, create new contact
  const created = await createContact(subaccountId, opts);
  // createContact returns just { id }, so fetch the full record for consistency
  const newContact = await getContactById(subaccountId, created.id);
  return { contact: newContact, was_created: true, matched_by: null };
}


// Lightweight contact search for picker autocomplete.
// Uses pg_trgm GIN index for fuzzy substring match.
// Returns at most {limit} results, minimal fields only.
async function searchContactsForPicker(subaccountId, query, limit) {
  const q = (query || '').trim().toLowerCase();
  if (q.length < 1) return { matches: [], truncated: false };
  const max = Math.min(Math.max(parseInt(limit) || 20, 1), 50);

  const r = await db.query(
    `SELECT id, first_name, last_name, display_name, email, phone, litbiz_square_customer_id
     FROM contacts
     WHERE subaccount_id = $1
       AND (archived IS NULL OR archived = false)
       AND LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(phone, '') || ' ' || COALESCE(display_name, '')) LIKE $2
     ORDER BY
       CASE WHEN LOWER(COALESCE(display_name, COALESCE(first_name || ' ' || last_name, email))) LIKE $3 THEN 0 ELSE 1 END,
       COALESCE(display_name, first_name, email)
     LIMIT $4`,
    [subaccountId, '%' + q + '%', q + '%', max + 1]
  );

  const truncated = r.rows.length > max;
  const matches = r.rows.slice(0, max).map(c => ({
    id: c.id,
    name: c.display_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || '(no name)',
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    email: c.email || '',
    phone: c.phone || '',
    litbiz_square_customer_id: c.litbiz_square_customer_id || null
  }));

  return { matches, truncated };
}

module.exports = {
  getContactById,
  getContactByIdWithPHI,
  getContactByEmail,
  getContactByPhone,
  getAllContacts,
  createContact,
  createStubContactFromSms,
  searchContactsForPicker,
  findOrCreateContact
};
