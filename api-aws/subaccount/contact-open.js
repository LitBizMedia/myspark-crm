// GET /api/subaccount/contact-open?id=<contactId>
//
// Returns a single contact with all PHI joins (notes, allergies, warnings,
// credit history) for the drawer view.
//
// Split from contact-list which returns a slim shape for the bulk list to
// stay under Lambda's 6MB response cap. This endpoint loads heavier per-contact
// data on demand when the user actually opens a contact drawer.

const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { getContactByIdWithPHI } = require('./lib/contacts');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param is required' });

  try {
    const contact = await getContactByIdWithPHI(auth.subaccount_id, id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.open',
      targetType: 'contact',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        display_name: contact.display_name || null,
        notes_count: (contact.notes||[]).length,
        allergies_count: (contact.allergies||[]).length,
        warnings_count: (contact.warnings||[]).length
      }
    });

    return res.status(200).json({ contact });
  } catch (err) {
    console.error('contact-open error:', err);
    return res.status(500).json({ error: 'Failed to load contact', detail: err.message });
  }
}

exports.handler = wrap(handler);
