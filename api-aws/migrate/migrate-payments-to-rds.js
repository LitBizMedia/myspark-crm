// Migration: payments from blob (subaccount_data.data->'payments') to dedicated RDS table.
//
// Two shapes exist in the existing blob:
//   - POS shape:    total, tipAmount, paymentMethod
//   - COF shape:    amount, tip, method
// Backfill normalizes both into the new schema using COALESCE.
//
// Schema includes Pattern B refund support fields (parent_payment_id, payment_type)
// for future event-sourced refunds, even though current code uses the simpler
// status-flag pattern. Cheap to add now, expensive to add later.
//
// Idempotent. Safe to re-run. CREATE TABLE uses IF NOT EXISTS, INSERT uses
// ON CONFLICT (id) DO NOTHING.

const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');

exports.handler = async (event) => {
  const signer = new Signer({
    region: 'us-east-2',
    hostname: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT || '5432', 10),
    username: process.env.RDS_USER
  });
  const token = await signer.getAuthToken();

  const pool = new Pool({
    host: process.env.RDS_PROXY_HOST,
    port: parseInt(process.env.RDS_PORT || '5432', 10),
    database: process.env.RDS_DATABASE,
    user: process.env.RDS_USER,
    password: token,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Create payments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                       TEXT PRIMARY KEY,
        subaccount_id            TEXT NOT NULL,

        -- Customer/staff (denormalized name fields kept for COF payment shape compatibility)
        contact_id               TEXT,
        contact_name             TEXT,
        staff_id                 TEXT,
        staff_name               TEXT,
        tip_staff_id             TEXT,

        -- Linkage for upcoming Take Payment feature
        appointment_id           TEXT,
        class_session_id         TEXT,
        participant_contact_id   TEXT,

        -- Future event-sourced refunds: payment_type 'sale' | 'refund' | 'void'
        -- and parent_payment_id pointing back to the original sale row.
        -- Not used by current code but added for forward compatibility.
        payment_type             TEXT NOT NULL DEFAULT 'sale',
        parent_payment_id        TEXT,

        -- Cart and pricing
        items                    JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal                 NUMERIC(10,2) NOT NULL DEFAULT 0,
        coupon_discount          NUMERIC(10,2) NOT NULL DEFAULT 0,
        coupon_code              TEXT,
        coupon_id                TEXT,
        discount_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
        discount_type            TEXT,
        discount_val             NUMERIC(10,2),
        discount_note            TEXT,
        after_discount           NUMERIC(10,2),
        fee_amount               NUMERIC(10,2) NOT NULL DEFAULT 0,
        tip_amount               NUMERIC(10,2) NOT NULL DEFAULT 0,
        credit_applied           NUMERIC(10,2) NOT NULL DEFAULT 0,
        total                    NUMERIC(10,2) NOT NULL DEFAULT 0,

        -- Method
        payment_method           TEXT NOT NULL DEFAULT 'other',
        card_last4               TEXT,
        card_brand               TEXT,
        payment_ref              TEXT,
        fail_reason              TEXT,

        -- Square
        square_payment_id        TEXT,
        square_receipt_url       TEXT,

        -- Gift card
        gift_card_id             TEXT,
        gift_card_code           TEXT,
        gift_card_applied        NUMERIC(10,2) DEFAULT 0,
        remainder_method         TEXT,
        remainder_ref            TEXT,
        remainder_status         TEXT,
        remainder_error          TEXT,

        -- Status and refund tracking (Pattern A flag style, currently in use)
        status                   TEXT NOT NULL DEFAULT 'completed',
        refunded_amount          NUMERIC(10,2) DEFAULT 0,
        refunded_at              TIMESTAMPTZ,
        refunded_by              TEXT,

        -- Sale type flags
        is_session_pack_sale     BOOLEAN DEFAULT FALSE,
        is_gift_card_sale        BOOLEAN DEFAULT FALSE,
        session_pack_id          TEXT,

        notes                    TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Step 2: Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_subaccount ON payments(subaccount_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_contact ON payments(contact_id) WHERE contact_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments(appointment_id) WHERE appointment_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(class_session_id) WHERE class_session_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_parent ON payments(parent_payment_id) WHERE parent_payment_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(subaccount_id, created_at DESC)`);

    // Step 3: Backfill from blob. Two shapes (POS and COF) handled via COALESCE.
    // Items is taken as JSONB; everything else cast appropriately.
    const backfill = await client.query(`
      INSERT INTO payments (
        id, subaccount_id,
        contact_id, contact_name, staff_id, staff_name, tip_staff_id,
        items,
        subtotal, coupon_discount, coupon_code, coupon_id,
        discount_amount, discount_type, discount_val, discount_note, after_discount,
        fee_amount, tip_amount, credit_applied, total,
        payment_method, card_last4, card_brand, payment_ref, fail_reason,
        square_payment_id, square_receipt_url,
        gift_card_id, gift_card_code, gift_card_applied,
        remainder_method, remainder_ref, remainder_status, remainder_error,
        status, refunded_amount, refunded_at, refunded_by,
        is_session_pack_sale, is_gift_card_sale, session_pack_id,
        notes, created_at, updated_at
      )
      SELECT
        p->>'id',
        sd.subaccount_id,

        NULLIF(p->>'contactId', ''),
        NULLIF(p->>'contactName', ''),
        NULLIF(p->>'staffId', ''),
        NULLIF(p->>'staffName', ''),
        NULLIF(p->>'tipStaffId', ''),

        COALESCE(p->'items', '[]'::jsonb),

        COALESCE((p->>'subtotal')::numeric, 0),
        COALESCE((p->>'couponDiscount')::numeric, 0),
        NULLIF(p->>'couponCode', ''),
        NULLIF(p->>'couponId', ''),
        COALESCE((p->>'discountAmount')::numeric, 0),
        NULLIF(p->>'discountType', ''),
        NULLIF((p->>'discountVal'), '')::numeric,
        NULLIF(p->>'discountNote', ''),
        NULLIF((p->>'afterDiscount'), '')::numeric,

        COALESCE((p->>'feeAmount')::numeric, 0),
        -- tip lives as 'tipAmount' on POS rows, 'tip' on COF rows. COALESCE both.
        COALESCE((p->>'tipAmount')::numeric, (p->>'tip')::numeric, 0),
        COALESCE((p->>'creditApplied')::numeric, 0),
        -- total lives as 'total' on POS rows, 'amount' on COF rows. COALESCE both.
        COALESCE((p->>'total')::numeric, (p->>'amount')::numeric, 0),

        -- method lives as 'paymentMethod' on POS rows, 'method' on COF rows.
        COALESCE(NULLIF(p->>'paymentMethod', ''), NULLIF(p->>'method', ''), 'other'),
        NULLIF(p->>'cardLast4', ''),
        NULLIF(p->>'cardBrand', ''),
        NULLIF(p->>'paymentRef', ''),
        NULLIF(p->>'failReason', ''),

        NULLIF(p->>'squarePaymentId', ''),
        NULLIF(p->>'squareReceiptUrl', ''),

        NULLIF(p->>'giftCardId', ''),
        NULLIF(p->>'giftCardCode', ''),
        COALESCE((p->>'giftCardApplied')::numeric, 0),

        NULLIF(p->>'remainderMethod', ''),
        NULLIF(p->>'remainderRef', ''),
        NULLIF(p->>'remainderStatus', ''),
        NULLIF(p->>'remainderError', ''),

        COALESCE(NULLIF(p->>'status', ''), 'completed'),
        COALESCE((p->>'refundedAmount')::numeric, 0),
        NULLIF(p->>'refundedAt', '')::timestamptz,
        NULLIF(p->>'refundedBy', ''),

        COALESCE((p->>'isSessionPackSale')::boolean, FALSE),
        COALESCE((p->>'isGiftCardSale')::boolean, FALSE),
        NULLIF(p->>'sessionPackId', ''),

        NULLIF(p->>'notes', ''),
        COALESCE((p->>'createdAt')::timestamptz, NOW()),
        COALESCE((p->>'updatedAt')::timestamptz, (p->>'createdAt')::timestamptz, NOW())
      FROM subaccount_data sd,
           jsonb_array_elements(COALESCE(sd.data->'payments', '[]'::jsonb)) AS p
      WHERE jsonb_typeof(sd.data->'payments') = 'array'
        AND p->>'id' IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `);

    // Step 4: Verify
    const verify = await client.query(`
      SELECT
        (SELECT to_regclass('payments') IS NOT NULL) AS table_exists,
        (SELECT COUNT(*) FROM payments)::int AS total_payments,
        (SELECT COUNT(DISTINCT subaccount_id) FROM payments)::int AS subaccounts_with_payments,
        (SELECT COUNT(*) FROM payments WHERE payment_method = 'gift_card')::int AS gift_card_payments,
        (SELECT COUNT(*) FROM payments WHERE payment_method = 'card_on_file')::int AS cof_payments,
        (SELECT COUNT(*) FROM payments WHERE is_session_pack_sale = TRUE)::int AS session_pack_sales,
        (SELECT COUNT(*) FROM payments WHERE is_gift_card_sale = TRUE)::int AS gift_card_sales,
        (SELECT COUNT(*) FROM payments WHERE status = 'refunded')::int AS refunded_payments,
        (SELECT COUNT(*) FROM payments WHERE status = 'failed')::int AS failed_payments,
        (SELECT COALESCE(SUM(total), 0) FROM payments WHERE status = 'completed')::numeric AS completed_revenue
    `);

    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Payments migration complete',
        backfilled: backfill.rowCount || 0,
        verify: verify.rows[0]
      })
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message, stack: err.stack })
    };
  } finally {
    client.release();
    await pool.end();
  }
};
