// lib/coupons.js
//
// Shared coupon accessor for backend Lambdas.
//
// Returns coupons in the camelCase shape callers expect (matching the
// legacy blob shape and the shape data-load.js sends to the frontend).
//
// This file is the single source of truth for backend coupon reads/writes.
// Future coupon schema changes are made here once.
//
// Redemption history lives in the coupon_redemptions child table, NOT inline.
// List reads attach an empty usageLog for shape compatibility; the real log
// is hydrated on demand via getCouponRedemptions().
//
// USAGE:
//   const { getAllCoupons, getCouponByCode, logRedemption } = require('./lib/coupons');
//   const all = await getAllCoupons(subaccountId);

const db = require('./db');

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

// Convert a coupons row (snake_case) to the camelCase shape the frontend uses.
// Matches the legacy blob shape exactly so db.coupons stays byte-compatible.
function couponToFrontend(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    discountType: row.discount_type,
    discountValue: row.discount_value != null ? Number(row.discount_value) : 0,
    appliesTo: row.applies_to,
    productIds: Array.isArray(row.product_ids) ? row.product_ids : [],
    maxUses: row.max_uses != null ? Number(row.max_uses) : null,
    oncePerCustomer: !!row.once_per_customer,
    recurringFirstOnly: !!row.recurring_first_only,
    expiryDate: tsToIso(row.expiry_date),
    usageCount: row.usage_count != null ? Number(row.usage_count) : 0,
    usageLog: [], // hydrated on demand via getCouponRedemptions
    createdAt: tsToIso(row.created_at),
    updatedAt: tsToIso(row.updated_at)
  };
}

// Convert a coupon_redemptions row to the camelCase usageLog entry shape the
// frontend usage modal expects: {id, contactId, paymentId, amountSaved, date, staffId}
function redemptionToFrontend(row) {
  if (!row) return null;
  return {
    id: row.id,
    contactId: row.contact_id || null,
    paymentId: row.payment_id || null,
    amountSaved: row.amount_saved != null ? Number(row.amount_saved) : 0,
    date: tsToIso(row.redeemed_at),
    staffId: row.staff_id || null
  };
}

// pg returns TIMESTAMPTZ as JS Date. Frontend expects ISO strings (or null).
function tsToIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// Map a frontend coupon payload (camelCase) to DB columns (snake_case).
// Used by upsert. Whitelist only; never spread arbitrary input.
function frontendToRow(subaccountId, opts) {
  return {
    subaccount_id: subaccountId,
    code: String(opts.code || '').trim(),
    name: opts.name != null ? String(opts.name) : null,
    status: opts.status === 'inactive' ? 'inactive' : 'active',
    discount_type: opts.discountType === 'flat' ? 'flat' : 'pct',
    discount_value: opts.discountValue != null ? Number(opts.discountValue) : 0,
    applies_to: ['all','pos','invoices','subscriptions'].includes(opts.appliesTo) ? opts.appliesTo : 'all',
    product_ids: JSON.stringify(Array.isArray(opts.productIds) ? opts.productIds : []),
    max_uses: opts.maxUses != null && opts.maxUses !== '' ? Number(opts.maxUses) : null,
    once_per_customer: !!opts.oncePerCustomer,
    recurring_first_only: !!opts.recurringFirstOnly,
    expiry_date: opts.expiryDate || null
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// All coupons for a subaccount, newest first. usageLog is empty (hydrate on demand).
async function getAllCoupons(subaccountId) {
  const r = await db.query(
    `SELECT * FROM coupons WHERE subaccount_id = $1 ORDER BY created_at DESC`,
    [subaccountId]
  );
  return r.rows.map(couponToFrontend);
}

// Single coupon by id (scoped to subaccount).
async function getCouponById(subaccountId, couponId) {
  const r = await db.query(
    `SELECT * FROM coupons WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, couponId]
  );
  return couponToFrontend(r.rows[0]);
}

// Single coupon by code, case-insensitive. This is the validation hot path
// (POS apply, appointment apply, booking widget, subscription charge).
async function getCouponByCode(subaccountId, code) {
  const r = await db.query(
    `SELECT * FROM coupons WHERE subaccount_id = $1 AND UPPER(code) = UPPER($2)`,
    [subaccountId, String(code || '').trim()]
  );
  return couponToFrontend(r.rows[0]);
}

// Redemption history for one coupon, newest first. Returns usageLog-shaped entries.
async function getCouponRedemptions(subaccountId, couponId) {
  const r = await db.query(
    `SELECT * FROM coupon_redemptions
      WHERE subaccount_id = $1 AND coupon_id = $2
      ORDER BY redeemed_at DESC`,
    [subaccountId, couponId]
  );
  return r.rows.map(redemptionToFrontend);
}

// Count redemptions for one coupon by a specific contact. Powers oncePerCustomer
// and the future per-customer usage limit. Indexed on (coupon_id, contact_id).
async function countRedemptionsByContact(subaccountId, couponId, contactId) {
  if (!contactId) return 0;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM coupon_redemptions
      WHERE subaccount_id = $1 AND coupon_id = $2 AND contact_id = $3`,
    [subaccountId, couponId, contactId]
  );
  return r.rows[0] ? r.rows[0].n : 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Create or update a coupon. id present and existing -> update; else insert.
// Case-insensitive code uniqueness is enforced by idx_coupons_sub_code; a
// duplicate throws a Postgres 23505 the endpoint translates to a clean error.
async function upsertCoupon(subaccountId, opts) {
  const row = frontendToRow(subaccountId, opts);
  const id = opts.id && /^cpn-/.test(opts.id) ? opts.id : null;

  if (id) {
    const existing = await db.query(
      `SELECT id FROM coupons WHERE subaccount_id = $1 AND id = $2`,
      [subaccountId, id]
    );
    if (existing.rows.length) {
      const r = await db.query(
        `UPDATE coupons SET
           code = $3, name = $4, status = $5, discount_type = $6,
           discount_value = $7, applies_to = $8, product_ids = $9::jsonb,
           max_uses = $10, once_per_customer = $11, recurring_first_only = $12,
           expiry_date = $13, updated_at = NOW()
         WHERE subaccount_id = $1 AND id = $2
         RETURNING *`,
        [subaccountId, id, row.code, row.name, row.status, row.discount_type,
         row.discount_value, row.applies_to, row.product_ids, row.max_uses,
         row.once_per_customer, row.recurring_first_only, row.expiry_date]
      );
      return couponToFrontend(r.rows[0]);
    }
  }

  const newId = id || ('cpn-' + genId());
  const r = await db.query(
    `INSERT INTO coupons
       (id, subaccount_id, code, name, status, discount_type, discount_value,
        applies_to, product_ids, max_uses, once_per_customer,
        recurring_first_only, expiry_date, usage_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,0)
     RETURNING *`,
    [newId, subaccountId, row.code, row.name, row.status, row.discount_type,
     row.discount_value, row.applies_to, row.product_ids, row.max_uses,
     row.once_per_customer, row.recurring_first_only, row.expiry_date]
  );
  return couponToFrontend(r.rows[0]);
}

// Toggle active/inactive. Returns the updated coupon.
async function setCouponStatus(subaccountId, couponId, status) {
  const next = status === 'inactive' ? 'inactive' : 'active';
  const r = await db.query(
    `UPDATE coupons SET status = $3, updated_at = NOW()
      WHERE subaccount_id = $1 AND id = $2 RETURNING *`,
    [subaccountId, couponId, next]
  );
  return couponToFrontend(r.rows[0]);
}

// Hard delete a coupon. Redemptions cascade via FK.
async function deleteCoupon(subaccountId, couponId) {
  await db.query(
    `DELETE FROM coupons WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, couponId]
  );
  return { ok: true };
}

// Log a redemption AND bump usage_count atomically. Called from payments-create
// and booking-submit ONLY on completed payments that carried a coupon.
//
// opts: { couponId, contactId, paymentId, amountSaved, staffId }
// Returns { ok, redemptionId, usageCount } or { ok:false, reason } if coupon gone.
async function logRedemption(subaccountId, opts) {
  const couponId = opts.couponId;
  if (!couponId) return { ok: false, reason: 'no_coupon_id' };

  return db.transaction(async (client) => {
    // Re-read the coupon inside the txn to confirm it still exists.
    const c = await client.query(
      `SELECT id FROM coupons WHERE subaccount_id = $1 AND id = $2 FOR UPDATE`,
      [subaccountId, couponId]
    );
    if (!c.rows.length) return { ok: false, reason: 'coupon_not_found' };

    const redemptionId = 'rdm-' + genId();
    await client.query(
      `INSERT INTO coupon_redemptions
         (id, coupon_id, subaccount_id, contact_id, payment_id, amount_saved, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [redemptionId, couponId, subaccountId,
       opts.contactId || null, opts.paymentId || null,
       opts.amountSaved != null ? Number(opts.amountSaved) : 0,
       opts.staffId || null]
    );
    const upd = await client.query(
      `UPDATE coupons SET usage_count = usage_count + 1, updated_at = NOW()
        WHERE id = $1 RETURNING usage_count`,
      [couponId]
    );
    return {
      ok: true,
      redemptionId,
      usageCount: upd.rows[0] ? Number(upd.rows[0].usage_count) : null
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Matches the frontend uid() entropy (random base36). Not crypto; ids are
// namespaced (cpn-, rdm-) and scoped per subaccount.
function genId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

module.exports = {
  couponToFrontend,
  redemptionToFrontend,
  getAllCoupons,
  getCouponById,
  getCouponByCode,
  getCouponRedemptions,
  countRedemptionsByContact,
  upsertCoupon,
  setCouponStatus,
  deleteCoupon,
  logRedemption
};
