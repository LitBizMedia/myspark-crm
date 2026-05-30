// api/agency/subaccount-link-contact.js (Lambda version)
//
// POST /api/agency/subaccount-link-contact
//
// Link or unlink a LitBiz contact to a subaccount's plan. Contact appears
// in Manage Plan modal so billing receipts and Square customer info can be
// associated with one CRM record.
//
// Body: { subaccountId, contactId }   contactId = null to unlink

const db = require('./lib/db');
const { requireAgencyAdminOrAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdminOrAgencyAuth(req, res);
  if (!auth) return;

  const { subaccountId, contactId } = req.body || {};
  if (!subaccountId) return res.status(400).json({ error: 'subaccountId required' });

  try {
    // Validate contact belongs to LitBiz workspace if a contact is being linked
    if (contactId) {
      const c = await db.query(
        `SELECT id, litbiz_square_customer_id FROM contacts
         WHERE id = $1 AND subaccount_id = 'sub-litbiz' LIMIT 1`,
        [contactId]
      );
      if (c.rows.length === 0) {
        return res.status(404).json({ error: 'Contact not found in LitBiz workspace' });
      }
    }

    // Update the plan
    await db.query(
      `UPDATE subaccount_plans
         SET linked_contact_id = $1, updated_at = NOW()
       WHERE subaccount_id = $2`,
      [contactId || null, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: contactId ? 'agency.subaccount.contact_link' : 'agency.subaccount.contact_unlink',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { contact_id: contactId || null }
    });

    return res.status(200).json({ success: true, contact_id: contactId || null });
  } catch (e) {
    console.error('subaccount-link-contact error:', e.message);
    return res.status(500).json({ error: 'Link failed: ' + e.message });
  }
}

exports.handler = wrap(handler);
