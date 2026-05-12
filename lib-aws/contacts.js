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
// Mirrors contactToFrontend() in data-load.js but without the joined arrays
// (notes/warnings/allergies/creditHistory) since most callers don't need them.
// If a caller needs those, they should call data-load.js or query directly.
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
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

// Standard SELECT column list. Keep in sync with data-load.js mapping.
const CONTACT_COLUMNS = `
  id, subaccount_id,
  first_name, last_name, display_name,
  email, phone, company, title, website,
  date_of_birth, gender, pronouns, preferred_language,
  address_line1, address_line2, city, state, postal_code, country, timezone,
  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  source, type, status, archived, tags, custom_field_values,
  credit_balance, square_customer_id, square_cards,
  created_at, updated_at, created_by, updated_by
`;

// Look up a single contact by id, scoped to subaccount.
// Returns the camelCase shape or null if not found.
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
// Useful for booking widget submissions to auto-link to an existing contact.
// Returns the camelCase shape or null if not found.
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

// Fetch all contacts for a subaccount.
// Returns array of camelCase contacts. Used by sub-charge iteration and
// subaccount-lifecycle Square cleanup.
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

module.exports = { getContactById, getContactByEmail, getAllContacts };
