// POST /api/subaccount/payment-refund
// Records a refund event against an existing payment.
//
// Body shape:
//   {
//     paymentId: string,
//     total: number,              // total refund this event (gc + card)
//     giftCardPortion: number,    // 0 if no GC involved
//     cardPortion: number,        // 0 if cash/other or full GC refund
//     reason: string,             // free text
//     squareRefunded: boolean,    // did Square API confirm refund
//     squareRefundId: string,     // optional, Square's refund id
//     gcRestored: boolean         // did we re-credit the gift card balance
//   }
//
// Behavior:
//   1. Validates the payment exists and belongs to the caller's subaccount
//   2. Computes new total refunded (existing refunded_amount + this.total)
//   3. Inserts a row into payment_refunds (audit trail per refund event)
//   4. Updates the payment row's refunded_amount, refunded_at, refunded_by, status
//   5. Audit logs the refund
//
// Status transitions:
//   completed -> partial_refund (newTotal < payment.total)
//   completed -> refunded (newTotal >= payment.total - 0.005)
//
// Money safety:
//   The new total refunded never exceeds payment.total (validated).
//   Both writes happen in a transaction; failure rolls back everything.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

function num(v, d) {
  var n = parseFloat(v);
  return (isNaN(n) || !isFinite(n)) ? (d || 0) : n;
}

function genId() {
  return 'ref-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  const paymentId = body.paymentId;
  if (!paymentId) {
    res.status(400).json({ error: 'paymentId is required' });
    return;
  }

  const refundTotal       = num(body.total, 0);
  const giftCardPortion   = num(body.giftCardPortion, 0);
  const cardPortion       = num(body.cardPortion, 0);
  const reason            = (body.reason || '').toString().slice(0, 500);
  const squareRefunded    = !!body.squareRefunded;
  const squareRefundId    = body.squareRefundId || null;
  const gcRestored        = !!body.gcRestored;

  if (refundTotal <= 0) {
    res.status(400).json({ error: 'Refund total must be greater than zero' });
    return;
  }

  // Validate portions sum (allow 1 cent rounding tolerance).
  const portionSum = giftCardPortion + cardPortion;
  if (Math.abs(portionSum - refundTotal) > 0.01) {
    res.status(400).json({
      error: 'Refund portions do not sum to total',
      detail: { giftCardPortion, cardPortion, portionSum, refundTotal }
    });
    return;
  }

  // Run in a transaction so all writes succeed or none do.
  const result = await db.transaction(async (client) => {
    // Lock the payment row to prevent concurrent refunds racing
    const pmtR = await client.query(
      `SELECT id, subaccount_id, total, refunded_amount, status
         FROM payments
        WHERE id = $1 AND subaccount_id = $2
        FOR UPDATE`,
      [paymentId, auth.subaccount_id]
    );
    if (!pmtR.rows.length) {
      const err = new Error('Payment not found');
      err.statusCode = 404;
      throw err;
    }
    const pmt = pmtR.rows[0];

    if (pmt.status === 'voided') {
      const err = new Error('Cannot refund a voided payment');
      err.statusCode = 400;
      throw err;
    }

    const prevRefunded = num(pmt.refunded_amount, 0);
    const newTotalRefunded = prevRefunded + refundTotal;
    const paymentTotal = num(pmt.total, 0);

    // Safety: never refund more than the payment total
    if (newTotalRefunded > paymentTotal + 0.01) {
      const err = new Error('Refund would exceed payment total');
      err.statusCode = 400;
      err.detail = { previouslyRefunded: prevRefunded, thisRefund: refundTotal, paymentTotal };
      throw err;
    }

    // Decide new status
    const isFull = Math.abs(newTotalRefunded - paymentTotal) < 0.01 || newTotalRefunded >= paymentTotal;
    const newStatus = isFull ? 'refunded' : 'partial_refund';

    // Insert the refund event
    const refundId = genId();
    await client.query(
      `INSERT INTO payment_refunds (
         id, payment_id, subaccount_id, refunded_at, refunded_by,
         total, gift_card_portion, card_portion,
         reason, square_refunded, square_refund_id, gc_restored
       ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        refundId, paymentId, auth.subaccount_id, auth.user_id,
        refundTotal, giftCardPortion, cardPortion,
        reason, squareRefunded, squareRefundId, gcRestored
      ]
    );

    // Update the payment row
    const updated = await client.query(
      `UPDATE payments
          SET refunded_amount = $1,
              refunded_at = NOW(),
              refunded_by = $2,
              status = $3,
              updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [newTotalRefunded, auth.user_id, newStatus, paymentId]
    );

    return {
      refundId,
      payment: updated.rows[0],
      newTotalRefunded,
      newStatus
    };
  });

  // Audit log (outside transaction; failure here doesn't roll back the refund)
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.payment.refund',
    targetType: 'payment',
    targetId: paymentId,
    targetSubaccountId: auth.subaccount_id,
    metadata: {
      refund_id: result.refundId,
      refund_total: refundTotal,
      gift_card_portion: giftCardPortion,
      card_portion: cardPortion,
      new_total_refunded: result.newTotalRefunded,
      new_status: result.newStatus,
      reason: reason,
      square_refunded: squareRefunded,
      square_refund_id: squareRefundId,
      gc_restored: gcRestored
    }
  });

  res.status(200).json({
    ok: true,
    refundId: result.refundId,
    paymentId: paymentId,
    newTotalRefunded: result.newTotalRefunded,
    newStatus: result.newStatus
  });
}

exports.handler = wrap(handler);
