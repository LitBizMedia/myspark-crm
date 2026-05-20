// POST /api/subaccount/automations-test-send
// Manually fires an automation against a specified contact, bypassing idempotency.
// Used by the editor preview button.
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { testFireAutomation } = require('./lib/automations');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const automationId = b.automation_id || b.id;
    const contactId = b.contact_id;
    if (!automationId) return res.status(400).json({ error: 'automation_id is required' });
    if (!contactId) return res.status(400).json({ error: 'contact_id is required' });

    const own = await db.query(
      'SELECT id FROM automations WHERE id = $1 AND subaccount_id = $2',
      [automationId, auth.subaccount_id]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Automation not found' });

    const ownContact = await db.query(
      'SELECT id FROM contacts WHERE id = $1 AND subaccount_id = $2',
      [contactId, auth.subaccount_id]
    );
    if (!ownContact.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const result = await testFireAutomation(automationId, contactId);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.automation.test_send',
      targetType: 'automation',
      targetId: automationId,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: contactId, result_status: result.status }
    });

    return res.status(200).json({ success: true, result });
  } catch (e) {
    console.error('automations-test-send error:', e.message);
    return res.status(500).json({ error: 'Failed to send test', detail: e.message });
  }
}

exports.handler = wrap(handler);
