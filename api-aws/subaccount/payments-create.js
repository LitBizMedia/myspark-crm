// POST /api/subaccount/payments-create
// Inserts a new payment row scoped to the caller's subaccount.
//
// Frontend generates the id and sends the full payment object. Numeric fields
// are coerced and defaults applied. Existing tipAmount/total/paymentMethod
// field names are preferred (the dual-shape migration was a one-time concern).

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const automations = require('./lib/automations');
const paymentReceipt = require('./lib/payment-receipt-email');
const contactsLib = require('./lib/contacts');
const couponsLib = require('./lib/coupons');
const giftCardsLib = require('./lib/gift-cards');
const gcPurchaseEmail = require('./lib/gift-card-purchase-email');

// Snake_case DB row -> camelCase shape the frontend uses.
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
    taxAmount: row.tax_amount != null ? parseFloat(row.tax_amount) : 0,
    taxableAmount: row.taxable_amount != null ? parseFloat(row.taxable_amount) : 0,
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

function num(v, def) {
  if (v == null || v === '') return def;
  var n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function bool(v, def) {
  if (v == null) return def;
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const p = req.body || {};
  if (!p.id || typeof p.id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!p.payment_method && !p.paymentMethod && !p.method) {
    return res.status(400).json({ error: 'payment_method is required' });
  }

  const subaccountId = auth.subaccount_id;
  // Frontend may send either snake_case (preferred) or legacy camelCase. Accept both.
  const paymentMethod = p.payment_method || p.paymentMethod || p.method || 'other';
  const total = num(p.total != null ? p.total : p.amount, 0);
  const tipAmount = num(p.tip_amount != null ? p.tip_amount : p.tipAmount != null ? p.tipAmount : p.tip, 0);

  try {
    const result = await db.transaction(async (txClient) => {
    const _ins = await txClient.query(`
      INSERT INTO payments (
        id, subaccount_id,
        contact_id, contact_name, staff_id, staff_name, tip_staff_id,
        appointment_id, class_session_id, participant_contact_id,
        payment_type, parent_payment_id,
        items,
        subtotal, coupon_discount, coupon_code, coupon_id,
        discount_amount, discount_type, discount_val, discount_note, after_discount,
        fee_amount, tax_amount, taxable_amount, tip_amount, credit_applied, total,
        payment_method, card_last4, card_brand, payment_ref, fail_reason,
        square_payment_id, square_receipt_url,
        gift_card_id, gift_card_code, gift_card_applied,
        remainder_method, remainder_ref, remainder_status, remainder_error,
        status, refunded_amount,
        is_session_pack_sale, is_gift_card_sale, session_pack_id,
        notes,
        created_at, updated_at
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12,
        $13::jsonb,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33,
        $34, $35,
        $36, $37, $38,
        $39, $40, $41, $42,
        $43, $44,
        $45, $46, $47,
        $48,
        NOW(), NOW()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `, [
      p.id, subaccountId,
      p.contact_id || p.contactId || null,
      p.contact_name || p.contactName || null,
      p.staff_id || p.staffId || null,
      p.staff_name || p.staffName || null,
      p.tip_staff_id || p.tipStaffId || null,
      p.appointment_id || p.appointmentId || null,
      p.class_session_id || p.classSessionId || null,
      p.participant_contact_id || p.participantContactId || null,
      p.payment_type || 'sale',
      p.parent_payment_id || p.parentPaymentId || null,
      JSON.stringify(p.items || []),
      num(p.subtotal, 0),
      num(p.coupon_discount != null ? p.coupon_discount : p.couponDiscount, 0),
      p.coupon_code || p.couponCode || null,
      p.coupon_id || p.couponId || null,
      num(p.discount_amount != null ? p.discount_amount : p.discountAmount, 0),
      p.discount_type || p.discountType || null,
      num(p.discount_val != null ? p.discount_val : p.discountVal, null),
      p.discount_note || p.discountNote || null,
      num(p.after_discount != null ? p.after_discount : p.afterDiscount, null),
      num(p.fee_amount != null ? p.fee_amount : p.feeAmount, 0),
      num(p.tax_amount != null ? p.tax_amount : p.taxAmount, 0),
      num(p.taxable_amount != null ? p.taxable_amount : p.taxableAmount, 0),
      tipAmount,
      num(p.credit_applied != null ? p.credit_applied : p.creditApplied, 0),
      total,
      paymentMethod,
      p.card_last4 || p.cardLast4 || null,
      p.card_brand || p.cardBrand || null,
      p.payment_ref || p.paymentRef || null,
      p.fail_reason || p.failReason || null,
      p.square_payment_id || p.squarePaymentId || null,
      p.square_receipt_url || p.squareReceiptUrl || null,
      p.gift_card_id || p.giftCardId || null,
      p.gift_card_code || p.giftCardCode || null,
      num(p.gift_card_applied != null ? p.gift_card_applied : p.giftCardApplied, 0),
      p.remainder_method || p.remainderMethod || null,
      p.remainder_ref || p.remainderRef || null,
      p.remainder_status || p.remainderStatus || null,
      p.remainder_error || p.remainderError || null,
      p.status || 'completed',
      num(p.refunded_amount != null ? p.refunded_amount : p.refundedAmount, 0),
      bool(p.is_session_pack_sale != null ? p.is_session_pack_sale : p.isSessionPackSale, false),
      bool(p.is_gift_card_sale != null ? p.is_gift_card_sale : p.isGiftCardSale, false),
      p.session_pack_id || p.sessionPackId || null,
      p.notes || null
    ]);

      // Same-transaction gift card deduction. Only when this is a NEW completed
      // payment carrying a gift card. If the row already existed (ON CONFLICT),
      // _ins.rowCount is 0 and we skip — the deduct already happened on first post.
      if (_ins.rowCount === 1) {
        const row = _ins.rows[0];
        const gcCode = row.gift_card_code;
        const gcApplied = row.gift_card_applied != null ? parseFloat(row.gift_card_applied) : 0;
        if (row.status === 'completed' && !row.is_gift_card_sale && gcCode && gcApplied > 0) {
          const ded = await giftCardsLib._deductOnClient(txClient, subaccountId, {
            lookupBy: 'code',
            code: gcCode,
            amount: gcApplied,
            note: 'Redeemed: ' + (row.payment_method || 'payment'),
            contactId: row.contact_id || null,
            paymentId: row.id,
            staffId: row.staff_id || null
          });
          if (!ded.ok) {
            // Fatal: roll back the payment so we never charge a gift card we
            // could not deduct (double-spend guard). Caller maps to an error.
            const err = new Error('gift_card_deduct_failed:' + ded.reason);
            err._gcReason = ded.reason;
            throw err;
          }
        }

        // Gift card SALE: create the new card in the SAME transaction, so the
        // card and its sale payment commit together. The code on the payment is
        // the NEW card's code (frontend-generated). Symmetric with the deduct.
        if (row.status === 'completed' && row.is_gift_card_sale && gcCode) {
          await giftCardsLib._createOnClient(txClient, subaccountId, {
            code: gcCode,
            originalAmount: parseFloat(row.total || 0),
            productId: p.gift_card_product_id || p.giftCardProductId || null,
            contactId: row.contact_id || null,
            recipientName: p.recipient_name || p.recipientName || null,
            recipientEmail: p.recipient_email || p.recipientEmail || null,
            isDigital: !!(p.is_digital || p.isDigital),
            issuedById: row.staff_id || null,
            soldVia: p.sold_via || p.soldVia || 'gift-card-tab',
            paymentId: row.id,
            paymentMethod: row.payment_method || null,
            squarePaymentId: row.square_payment_id || null,
            note: 'Sold via ' + (row.payment_method || 'sale')
          });
        }
      }
      return _ins;
    });

    if (result.rowCount === 0) {
      // Conflict: id already exists. Return existing row for idempotency.
      const existing = await db.query(
        'SELECT * FROM payments WHERE id=$1 AND subaccount_id=$2',
        [p.id, subaccountId]
      );
      return res.status(200).json({ success: true, payment: paymentToFrontend(existing.rows[0]), duplicate: true });
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.payment.create',
      targetType: 'payment', targetId: p.id,
      targetSubaccountId: subaccountId,
      metadata: {
        method: paymentMethod,
        total: total,
        contact_id: p.contact_id || p.contactId || null,
        appointment_id: p.appointment_id || p.appointmentId || null,
        class_session_id: p.class_session_id || p.classSessionId || null,
        is_session_pack_sale: bool(p.is_session_pack_sale != null ? p.is_session_pack_sale : p.isSessionPackSale, false),
        is_gift_card_sale: bool(p.is_gift_card_sale != null ? p.is_gift_card_sale : p.isGiftCardSale, false)
      }
    });

    // Fire automation trigger (await: low frequency, want reliable delivery)
    try {
      const pmt = result.rows[0];
      if (pmt.contact_id) {
        await automations.fireAutomationTriggers('payment_received', {
          subaccountId: auth.subaccount_id,
          contactId: pmt.contact_id,
          paymentId: pmt.id,
          amount: parseFloat(pmt.total || 0),
          paymentMethod: pmt.payment_method || ''
        });
      }
    } catch (autoErr) {
      console.error('Automation trigger fire error (non-fatal):', autoErr.message);
    }

    // Fire patient payment receipt (non-fatal). Gates via Notifications tab.
    // Source detection + filter checking happens inside the lib.
    try {
      const pmt = result.rows[0];
      if (pmt.contact_id && pmt.status === 'completed') {
        const contact = await contactsLib.getContactById(subaccountId, pmt.contact_id);
        if (contact && contact.email) {
          // Look up business name from settings
          let businessName = 'MySpark+';
          try {
            const sdRow = await db.findOne('subaccount_data', { subaccount_id: subaccountId });
            const settings = (sdRow && sdRow.data && sdRow.data.settings) || {};
            businessName = settings.businessName || settings.business_name || businessName;
          } catch (e) { /* default */ }

          const slug = subaccountId.replace(/^sub-/, '');

          // Source-specific enrichment
          let appointmentTitle = null;
          if (pmt.appointment_id) {
            try {
              const apptRes = await db.query(
                'SELECT title FROM appointments WHERE id = $1 AND subaccount_id = $2 LIMIT 1',
                [pmt.appointment_id, subaccountId]
              );
              if (apptRes.rows[0]) appointmentTitle = apptRes.rows[0].title;
            } catch (e) { /* skip */ }
          }

          await paymentReceipt.sendPaymentReceipt({
            payment: pmt,
            subaccountId,
            subaccountSlug: slug,
            recipientEmail: contact.email,
            recipientName: contact.name || contact.first_name || '',
            contactId: contact.id,
            businessName,
            appointmentTitle
          });
        }
      }
    } catch (recErr) {
      console.warn('payment receipt send failed (non-fatal):', recErr.message);
    }

    // Deliver a DIGITAL gift card to its recipient (non-fatal). Separate from
    // the receipt block because a gift card sale may have NO buyer contact, and
    // the recipient email lives on the card, not the contact. Standalone sender
    // is reused by the future public gift card catalog. Gate inside the lib.
    try {
      const pmt = result.rows[0];
      if (pmt.status === 'completed' && pmt.is_gift_card_sale && pmt.gift_card_code) {
        // The digital flag + recipient live on the CARD (gift_cards), not the
        // payment row. Fetch the card just created in this txn by payment_id.
        const cardRes = await db.query(
          `SELECT code, balance, is_digital, recipient_email, recipient_name, product_id
             FROM gift_cards WHERE payment_id=$1 AND subaccount_id=$2 LIMIT 1`,
          [pmt.id, subaccountId]
        );
        const card = cardRes.rows[0];
        if (card && card.is_digital) {
          // Recipient email is authoritative; fall back to buyer contact email.
          let buyerEmail = '', buyerName = '';
          if (pmt.contact_id) {
            try {
              const c = await contactsLib.getContactById(subaccountId, pmt.contact_id);
              if (c) { buyerEmail = c.email || ''; buyerName = c.name || c.first_name || ''; }
            } catch (e) { /* skip */ }
          }
          let businessName = 'MySpark+', productName = 'Gift Card', terms = '';
          try {
            const sdRow = await db.findOne('subaccount_data', { subaccount_id: subaccountId });
            const settings = (sdRow && sdRow.data && sdRow.data.settings) || {};
            businessName = settings.businessName || settings.business_name || businessName;
          } catch (e) { /* default */ }
          try {
            if (card.product_id) {
              const pr = await db.query(
                'SELECT name, terms FROM gift_card_products WHERE id=$1 AND subaccount_id=$2 LIMIT 1',
                [card.product_id, subaccountId]
              );
              if (pr.rows[0]) { productName = pr.rows[0].name || productName; terms = pr.rows[0].terms || ''; }
            }
          } catch (e) { /* skip */ }
          const slug = subaccountId.replace(/^sub-/, '');
          await gcPurchaseEmail.sendGiftCardPurchase({
            subaccountId,
            slug,
            code: card.code,
            balance: card.balance,
            recipientName: card.recipient_name || null,
            recipientEmail: card.recipient_email || null,
            buyerEmail,
            buyerName,
            productName,
            terms,
            businessName
          });
        }
      }
    } catch (gcErr) {
      console.warn('gift card purchase email failed (non-fatal):', gcErr.message);
    }

    // Log coupon redemption (non-fatal). Consolidation point for ALL in-app
    // payments: POS, appointment, gift-card sale, etc. The frontend no longer
    // logs usage; it only sends coupon_id on the payment (blob migration 2026-06-03).
    // Idempotency: a duplicate payment post hits the ON CONFLICT early-return above,
    // so this runs exactly once per real payment. Gate matches the receipt block:
    // completed status + a coupon present.
    try {
      const pmt = result.rows[0];
      if (pmt.status === 'completed' && pmt.coupon_id) {
        await couponsLib.logRedemption(subaccountId, {
          couponId: pmt.coupon_id,
          contactId: pmt.contact_id || null,
          paymentId: pmt.id,
          amountSaved: parseFloat(pmt.coupon_discount || 0),
          staffId: pmt.staff_id || null
        });
      }
    } catch (redeemErr) {
      console.error('coupon redemption logging failed (non-fatal):', redeemErr.message);
    }

    return res.status(200).json({ success: true, payment: paymentToFrontend(result.rows[0]) });
  } catch (e) {
    if (e && e._gcReason) {
      const map = {
        not_found: [404, 'Gift card not found'],
        insufficient_balance: [409, 'Gift card balance is too low for that amount'],
        card_voided: [409, 'This gift card has been voided'],
        card_refunded: [409, 'This gift card has been refunded'],
        bad_amount: [400, 'Invalid gift card amount']
      };
      const m = map[e._gcReason] || [409, 'Gift card could not be redeemed'];
      console.warn('payments-create gift card deduct rejected:', e._gcReason);
      return res.status(m[0]).json({ error: m[1], reason: e._gcReason });
    }
    console.error('payments-create error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to create payment' });
  }
}

exports.handler = wrap(handler);
