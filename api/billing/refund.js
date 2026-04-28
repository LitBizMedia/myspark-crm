// api/billing/refund.js
// Refund a successful Square payment for a subaccount invoice.
// Currently supports full refunds only.

const { getAgencyCreds, makeIdempotencyKey } = require('../../lib/agency-billing');
const { sendError, squareHost, squareHeaders } = require('../../lib/square');
const { logAudit } = require('../../lib/audit');
const { requireAgencyAuth } = require('../../lib/require-subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const { invoiceId, reason } = req.body || {};
  if (!invoiceId) return sendError(res, 400, 'invoiceId required');

  // Require valid agency session
  const auth = await requireAgencyAuth(req, res);
  if (!auth) return; // 401 already sent
  const actor = {
    actorType:     'agency',
    actorId:       auth.user_id,
    actorUsername: auth.username,
    actorRole:     auth.role
  };

  try {
    // Load the invoice
    const invRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_invoices?id=eq.' + encodeURIComponent(invoiceId) + '&select=*',
      { headers: sbHeaders() }
    );
    if (!invRes.ok) return sendError(res, 500, 'Could not load invoice');
    const rows = await invRes.json();
    if (!rows || !rows.length) return sendError(res, 404, 'Invoice not found');
    const invoice = rows[0];

    // Validate refundable
    if (invoice.status !== 'succeeded') {
      await logAudit({
        req, ...actor,
        action: 'agency.billing.refund',
        targetType: 'invoice',
        targetId: invoiceId,
        targetSubaccountId: invoice.subaccount_id,
        outcome: 'denied',
        errorMessage: 'Only succeeded invoices can be refunded. Current status: ' + invoice.status
      });
      return sendError(res, 400, 'Only succeeded invoices can be refunded. Current status: ' + invoice.status);
    }
    if (!invoice.square_payment_id) {
      await logAudit({
        req, ...actor,
        action: 'agency.billing.refund',
        targetType: 'invoice',
        targetId: invoiceId,
        targetSubaccountId: invoice.subaccount_id,
        outcome: 'denied',
        errorMessage: 'No Square payment ID on this invoice'
      });
      return sendError(res, 400, 'No Square payment ID on this invoice');
    }

    // Build the Square refund call
    const creds = await getAgencyCreds();
    const idempotencyKey = makeIdempotencyKey('ref', invoiceId);
    const refundBody = {
      idempotency_key: idempotencyKey,
      amount_money: { amount: invoice.amount_cents, currency: 'USD' },
      payment_id: invoice.square_payment_id
    };
    if (reason) refundBody.reason = String(reason).slice(0, 192);

    const squareRes = await fetch(
      'https://' + squareHost(creds.sandbox) + '/v2/refunds',
      {
        method: 'POST',
        headers: squareHeaders(creds.access_token),
        body: JSON.stringify(refundBody)
      }
    );

    const squareText = await squareRes.text();
    let squareJson = null;
    try { squareJson = JSON.parse(squareText); } catch (e) {}

    if (!squareRes.ok) {
      const errMsg = (squareJson && squareJson.errors) ? JSON.stringify(squareJson.errors) : squareText;
      await logAudit({
        req, ...actor,
        action: 'agency.billing.refund',
        targetType: 'invoice',
        targetId: invoiceId,
        targetSubaccountId: invoice.subaccount_id,
        outcome: 'failure',
        errorMessage: 'Square refund failed: ' + errMsg,
        metadata: {
          amount_cents: invoice.amount_cents,
          square_payment_id: invoice.square_payment_id
        }
      });
      return sendError(res, 502, 'Square refund failed: ' + errMsg);
    }

    const refund = squareJson && squareJson.refund;
    const now = new Date().toISOString();

    // Update invoice in DB
    const updateRes = await fetch(
      SUPABASE_URL + '/rest/v1/subaccount_invoices?id=eq.' + encodeURIComponent(invoiceId),
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({
          status: 'refunded',
          refunded_at: now,
          square_refund_id: refund && refund.id,
          refund_reason: reason || null,
          refunded_by_username: actor.actorUsername || null
        })
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      // Square already refunded, but DB update failed. Log and surface.
      console.error('refund: Square refund succeeded but DB update failed. Refund ID:', refund && refund.id, 'Error:', errText);
      await logAudit({
        req, ...actor,
        action: 'agency.billing.refund',
        targetType: 'invoice',
        targetId: invoiceId,
        targetSubaccountId: invoice.subaccount_id,
        outcome: 'failure',
        errorMessage: 'DB update failed after Square refund succeeded: ' + errText,
        metadata: {
          square_refund_id: refund && refund.id,
          amount_cents: invoice.amount_cents,
          warning: 'Square refund completed but invoice record may be stale'
        }
      });
      return res.status(500).json({
        error: 'Refund processed but invoice record update failed. Square refund ID: ' + (refund && refund.id),
        square_refund_id: refund && refund.id
      });
    }

    // Audit success
    await logAudit({
      req, ...actor,
      action: 'agency.billing.refund',
      targetType: 'invoice',
      targetId: invoiceId,
      targetSubaccountId: invoice.subaccount_id,
      metadata: {
        amount_cents: invoice.amount_cents,
        square_payment_id: invoice.square_payment_id,
        square_refund_id: refund && refund.id,
        reason: reason || null,
        original_invoice_description: invoice.description
      }
    });

    return res.status(200).json({
      success: true,
      square_refund_id: refund && refund.id,
      amount_cents: invoice.amount_cents
    });

  } catch (e) {
    console.error('refund error:', e);
    await logAudit({
      req, ...actor,
      action: 'agency.billing.refund',
      targetType: 'invoice',
      targetId: invoiceId,
      outcome: 'failure',
      errorMessage: e.message
    });
    return sendError(res, 500, 'Refund failed', e.message);
  }
};
