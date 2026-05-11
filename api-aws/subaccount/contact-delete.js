// POST /api/subaccount/contact-delete
// Hard-deletes a contact. Admin role only. Contact must be archived first.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;
  try {
    const b = req.body || {};
    const id = b.id;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const check = await db.query(
      `SELECT id, display_name, archived FROM contacts WHERE id = $1 AND subaccount_id = $2`,
      [id, auth.subaccount_id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Contact not found' });
    if (!check.rows[0].archived) {
      return res.status(400).json({ error: 'Contact must be archived before deletion' });
    }

    const childCounts = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM contact_notes WHERE contact_id = $1) AS notes,
         (SELECT COUNT(*)::int FROM contact_warnings WHERE contact_id = $1) AS warnings,
         (SELECT COUNT(*)::int FROM contact_allergies WHERE contact_id = $1) AS allergies,
         (SELECT COUNT(*)::int FROM contact_credit_log WHERE contact_id = $1) AS credit_log`,
      [id]
    );

    const r = await db.query(
      `DELETE FROM contacts WHERE id = $1 AND subaccount_id = $2 RETURNING id`,
      [id, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contact not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact.delete',
      targetType: 'contact', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        display_name: check.rows[0].display_name,
        cascaded: childCounts.rows[0]
      }
    });

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('contact-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
}
exports.handler = wrap(handler);
