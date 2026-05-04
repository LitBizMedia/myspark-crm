// POST /api/subaccount/payments-update
// Updates whitelisted fields on an existing payment row.
//
// Allowed updates: status flips (refunded, voided, failed), refund tracking,
// post-tokenize Square IDs, gift card remainder fields, card detail backfill,
// fail reason, notes.
//
// NOT allowed: financial amounts (subtotal, total, discount, tip), method,
// items. Payment financials are immutable for audit. To "correct" amounts,
// void the payment and create a new one.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

// Whitelisted update fields. Maps incoming key -> SQL column name.
// Frontend may send either snake_case or camelCase; both keys map to same column.
const ALLOWED_FIELDS = {
  status:               'status',
  refunded_amount:      'refunded_amount',
  refundedAmount:       'refunded_amount',
  refunded_at:          'refunded_at',
  refundedAt:           'refunded_at',
  refunded_by:          'refunded_by',
  refundedBy:           'refunded_by',
  square_payment_id:    'square_payment_id',
  squarePaymentId:      'square_payment_id',
  square_receipt_url:   'square_receipt_url',
  squareReceiptUrl:     'square_receipt_url',
  remainder_status:     'remainder_status',
  remainderStatus:      'remainder_status',
  remainder_error:      'remainder_error',
  remainderError:       'remainder_error',
  remainder_ref:        'remainder_ref',
  remainderRef:         'remainder_ref',
  card_last4:           'card_last4',
  cardLast4:            'card_last4',
  card_brand:           'card_brand',
  cardBrand:            'card_brand',
  fail_reason:          'fail_reason',
  failReason:           'fail_reason',
  notes:                'notes'
};

const NUMERIC_COLUMNS = new Set(['refunded_amount']);
const TIMESTAMP_COLUMNS = new Set(['refunded_at']);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const body = req.body || {};
  if (!body.id || typeof body.id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  // Build SET clause from whitelisted fields. Track sent keys for audit.
  const updates = {};
  for (const key in body) {
    if (key === 'id' || !ALLOWED_FIELDS.hasOwnProperty(key)) continue;
    const col = ALLOWED_FIELDS[key];
    let val = body[key];
    if (val === '') val = null;
    if (NUMERIC_COLUMNS.has(col) && val != null) {
      const n = parseFloat(val);
      val = isNaN(n) ? null : n;
    }
    updates[col] = val;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no updatable fields provided' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const setClauses = [];
    const params = [];
    let i = 1;
    for (const col in updates) {
      let placeholder = '$' + i;
      if (TIMESTAMP_COLUMNS.has(col) && updates[col] != null) {
        placeholder = '$' + i + '::timestamptz';
      }
      setClauses.push(col + ' = ' + placeholder);
      params.push(updates[col]);
      i++;
    }
    setClauses.push('updated_at = NOW()');

    params.push(body.id);          // $i
    params.push(subaccountId);     // $i+1

    const sql = 'UPDATE payments SET ' + setClauses.join(', ') +
                ' WHERE id = $' + i + ' AND subaccount_id = $' + (i + 1) +
                ' RETURNING *';

    const result = await db.query(sql, params);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'payment not found' });
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.payment.update',
      targetType: 'payment', targetId: body.id,
      targetSubaccountId: subaccountId,
      metadata: { fields_updated: Object.keys(updates), new_status: updates.status || undefined }
    });

    return res.status(200).json({ success: true, payment: result.rows[0] });
  } catch (e) {
    console.error('payments-update error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to update payment' });
  }
}

exports.handler = wrap(handler);
