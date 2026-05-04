// api/subaccount/data-load.js (Lambda version)
// GET /api/subaccount/data-load
// Loads the bulk subaccount_data JSONB blob plus services, variations, class
// sessions, users, service_categories, service_widgets, and payments.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

// Maps a payments table row (snake_case) to the camelCase shape the
// frontend expects (matching the legacy blob shape).
function paymentToFrontend(row) {
  if (!row) return row;
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    staffId: row.staff_id,
    staffName: row.staff_name,
    tipStaffId: row.tip_staff_id,
    appointmentId: row.appointment_id,
    classSessionId: row.class_session_id,
    participantContactId: row.participant_contact_id,
    paymentType: row.payment_type,
    parentPaymentId: row.parent_payment_id,
    items: row.items || [],
    subtotal: row.subtotal != null ? parseFloat(row.subtotal) : 0,
    couponDiscount: row.coupon_discount != null ? parseFloat(row.coupon_discount) : 0,
    couponCode: row.coupon_code,
    couponId: row.coupon_id,
    discountAmount: row.discount_amount != null ? parseFloat(row.discount_amount) : 0,
    discountType: row.discount_type,
    discountVal: row.discount_val != null ? parseFloat(row.discount_val) : null,
    discountNote: row.discount_note,
    afterDiscount: row.after_discount != null ? parseFloat(row.after_discount) : null,
    feeAmount: row.fee_amount != null ? parseFloat(row.fee_amount) : 0,
    tipAmount: row.tip_amount != null ? parseFloat(row.tip_amount) : 0,
    creditApplied: row.credit_applied != null ? parseFloat(row.credit_applied) : 0,
    total: row.total != null ? parseFloat(row.total) : 0,
    paymentMethod: row.payment_method,
    cardLast4: row.card_last4,
    cardBrand: row.card_brand,
    paymentRef: row.payment_ref,
    failReason: row.fail_reason,
    squarePaymentId: row.square_payment_id,
    squareReceiptUrl: row.square_receipt_url,
    giftCardId: row.gift_card_id,
    giftCardCode: row.gift_card_code,
    giftCardApplied: row.gift_card_applied != null ? parseFloat(row.gift_card_applied) : 0,
    remainderMethod: row.remainder_method,
    remainderRef: row.remainder_ref,
    remainderStatus: row.remainder_status,
    remainderError: row.remainder_error,
    status: row.status,
    refundedAmount: row.refunded_amount != null ? parseFloat(row.refunded_amount) : 0,
    refundedAt: row.refunded_at,
    refundedBy: row.refunded_by,
    isSessionPackSale: !!row.is_session_pack_sale,
    isGiftCardSale: !!row.is_gift_card_sale,
    sessionPackId: row.session_pack_id,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  try {
    const [blobResult, servicesResult, variationsResult, classesResult, usersResult, widgetsResult, paymentsResult] = await Promise.all([
      db.query(
        'SELECT data, service_categories FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM services WHERE subaccount_id = $1 ORDER BY created_at ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT sv.* FROM service_variations sv
         JOIN services s ON sv.service_id = s.id
         WHERE s.subaccount_id = $1
         ORDER BY sv.created_at ASC`,
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM class_sessions WHERE subaccount_id = $1 ORDER BY date ASC, time ASC',
        [subaccountId]
      ),
      db.query(
        `SELECT id, username, display_name, email, role, color, active,
                schedule, date_overrides, must_change_password,
                created_at, updated_at
         FROM subaccount_users
         WHERE subaccount_id = $1
         ORDER BY created_at ASC`,
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM service_widgets WHERE subaccount_id = $1 ORDER BY created_at ASC',
        [subaccountId]
      ),
      db.query(
        'SELECT * FROM payments WHERE subaccount_id = $1 ORDER BY created_at DESC',
        [subaccountId]
      )
    ]);

    return res.status(200).json({
      data: blobResult.rows[0]?.data || null,
      services: servicesResult.rows,
      serviceVariations: variationsResult.rows,
      classSessions: classesResult.rows,
      users: usersResult.rows,
      serviceCategories: blobResult.rows[0]?.service_categories || [],
      serviceWidgets: widgetsResult.rows,
      payments: paymentsResult.rows.map(paymentToFrontend)
    });
  } catch (e) {
    console.error('data-load error:', e.message);
    return res.status(500).json({ error: 'Failed to load data' });
  }
}

exports.handler = wrap(handler);
