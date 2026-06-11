// api/subaccount/payments-mark-paid.js (Lambda)
// POST /api/subaccount/payments-mark-paid
// Transitions a payment from status='pending' to status='completed' with the
// specified collection method.
//
// Body: { id, paymentMethod, paymentRef? }
//
// Validation:
//   - Payment must exist in this subaccount
//   - Payment must currently be status='pending'
//   - paymentMethod must be one of: cash, check, card, other
//   - paymentRef is optional (check number, card last 4, txn id)
//
// On success, updates: status='completed', payment_method=<method>, payment_ref=<ref>
// Audit log records the transition and method.
//
// This endpoint exists separately from payments-update.js because it has stricter
// semantics: payment_method is normally immutable, but for pending->completed
// transitions we need to capture how the money was collected.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { MANAGER_UP } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const VALID_METHODS = ['cash', 'check', 'card', 'other'];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: MANAGER_UP });
  if (!auth) return;

  // Only admins and managers can mark payments as paid. Staff cannot.

  const body = req.body || {};
  const id = body.id;
  const paymentMethod = body.paymentMethod;
  const paymentRef = body.paymentRef ? String(body.paymentRef).slice(0, 100) : null;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!paymentMethod || !VALID_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be one of: ' + VALID_METHODS.join(', ') });
  }

  const subaccountId = auth.subaccount_id;

  try {
    // Fetch existing to validate state transition
    const existing = await db.query(
      'SELECT id, status, payment_type, total, contact_id FROM payments WHERE id = $1 AND subaccount_id = $2',
      [id, subaccountId]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const current = existing.rows[0];
    if (current.status !== 'pending') {
      return res.status(409).json({
        error: 'Payment is not pending (current status: ' + current.status + '). Only pending payments can be marked as paid.'
      });
    }

    // Transition: status -> completed, set method and ref
    const updateRes = await db.query(
      `UPDATE payments
       SET status = 'completed',
           payment_method = $1,
           payment_ref = $2,
           updated_at = NOW()
       WHERE id = $3 AND subaccount_id = $4 AND status = 'pending'
       RETURNING *`,
      [paymentMethod, paymentRef, id, subaccountId]
    );

    if (updateRes.rowCount === 0) {
      // Race condition: status changed between SELECT and UPDATE
      return res.status(409).json({ error: 'Payment status changed during update. Refresh and try again.' });
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.payment.mark_paid',
      targetType: 'payment',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {
        payment_type: current.payment_type,
        total: parseFloat(current.total) || 0,
        method: paymentMethod,
        ref: paymentRef,
        contact_id: current.contact_id
      }
    });

    return res.status(200).json({ success: true, payment_id: id, status: 'completed', method: paymentMethod });
  } catch (e) {
    console.error('payments-mark-paid error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to mark payment as paid' });
  }
}

exports.handler = wrap(handler);
