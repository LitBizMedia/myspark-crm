// api/subaccount/subscriptions-delete.js (Lambda)
// POST /api/subaccount/subscriptions-delete
// Hard deletes a subscription and its event history. Admin-only.
// Body: { id }
//
// This is for "I created this by mistake" scenarios. For ending a customer's
// subscription normally, use the cancel action via subscriptions-update.
//
// All subscription_events for this subscription are cascaded by the FK.
// We snapshot the sub content into the audit log BEFORE delete so there's
// permanent record even after the row is gone.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  // Hard delete is admin-only (and super_admin). Manager cannot.
  if (auth.role !== 'admin' && auth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only admins can hard-delete subscriptions' });
  }

  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const existing = await db.query(
      `SELECT * FROM subscriptions WHERE id = $1 AND subaccount_id = $2`,
      [id, auth.subaccount_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Subscription not found' });
    const sub = existing.rows[0];

    // Audit BEFORE delete with full content snapshot. Compliance requirement:
    // we never lose track of money-affecting records, even when admin deletes them.
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.subscription.delete',
      targetType: 'subscription',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        snapshot: {
          contact_id: sub.contact_id,
          plan_id: sub.plan_id,
          plan_name: sub.plan_name_snapshot,
          billing_cycle: sub.billing_cycle,
          cycle_price: parseFloat(sub.cycle_price),
          status: sub.status,
          start_date: sub.start_date,
          items: sub.items,
          created_at: sub.created_at,
          last_charged_at: sub.last_charged_at
        }
      }
    });

    // Subscription_events cascade automatically via FK ON DELETE CASCADE
    await db.query(
      'DELETE FROM subscriptions WHERE id = $1 AND subaccount_id = $2',
      [id, auth.subaccount_id]
    );

    return res.status(200).json({ success: true, deleted: id });
  } catch (e) {
    console.error('subscriptions-delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete subscription' });
  }
}

exports.handler = wrap(handler);
