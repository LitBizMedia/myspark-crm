// lib/gift-card-products.js
//
// Gift card product (template) accessor. Mirrors lib/coupons.js + gift-cards.js.
// Products define the card design (colors, background image), denominations,
// the custom-amount toggle, and terms. The background image is stored as an S3
// key (bg_image_s3_key); the legacy blob stored an inline data URL on bgImage.
//
// bgImage URL resolution is intentionally NOT done here. The mapper returns
// bgImageS3Key raw and leaves bgImage as '' for the caller to resolve once the
// Phase 4 storage decision is locked (KMS media-bucket presign vs a public
// images path). Resolving here would bake in an assumption we have not made.

const db = require('./db');

function tsToIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// gift_card_products row -> camelCase. bgImage left for the caller to resolve
// from bgImageS3Key (see header note).
function productToFrontend(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    bgColor1: row.bg_color1 || null,
    bgColor2: row.bg_color2 || null,
    bgImageS3Key: row.bg_image_s3_key || null,
    bgImage: '', // resolved by caller in Phase 4; see header
    denominations: Array.isArray(row.denominations) ? row.denominations : [],
    customAmount: !!row.custom_amount,
    terms: row.terms || '',
    createdAt: tsToIso(row.created_at),
    updatedAt: tsToIso(row.updated_at)
  };
}

// Map a frontend product payload (camelCase) to DB columns. Whitelist only.
function frontendToRow(subaccountId, opts) {
  return {
    subaccount_id: subaccountId,
    name: opts.name != null ? String(opts.name) : 'Gift Card',
    status: opts.status === 'archived' ? 'archived' : 'active',
    bg_color1: opts.bgColor1 || '#6b21ea',
    bg_color2: opts.bgColor2 || '#ff4000',
    bg_image_s3_key: opts.bgImageS3Key || null,
    denominations: JSON.stringify(Array.isArray(opts.denominations) ? opts.denominations : []),
    custom_amount: !!opts.customAmount,
    terms: opts.terms != null ? String(opts.terms) : null
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getAllProducts(subaccountId) {
  const r = await db.query(
    `SELECT * FROM gift_card_products WHERE subaccount_id = $1 ORDER BY created_at DESC`,
    [subaccountId]
  );
  return r.rows.map(productToFrontend);
}

async function getProductById(subaccountId, productId) {
  const r = await db.query(
    `SELECT * FROM gift_card_products WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, productId]
  );
  return productToFrontend(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Create or update a product. id present and existing -> update; else insert.
async function upsertProduct(subaccountId, opts) {
  const row = frontendToRow(subaccountId, opts);
  const id = (opts.id && /^gcp-/.test(opts.id)) ? opts.id : null;

  if (id) {
    const existing = await db.query(
      `SELECT id FROM gift_card_products WHERE subaccount_id = $1 AND id = $2`,
      [subaccountId, id]
    );
    if (existing.rows.length) {
      const r = await db.query(
        `UPDATE gift_card_products SET
           name = $3, status = $4, bg_color1 = $5, bg_color2 = $6,
           bg_image_s3_key = $7, denominations = $8::jsonb, custom_amount = $9,
           terms = $10, updated_at = NOW()
         WHERE subaccount_id = $1 AND id = $2
         RETURNING *`,
        [subaccountId, id, row.name, row.status, row.bg_color1, row.bg_color2,
         row.bg_image_s3_key, row.denominations, row.custom_amount, row.terms]
      );
      return productToFrontend(r.rows[0]);
    }
  }

  const newId = id || ('gcp-' + genId());
  const r = await db.query(
    `INSERT INTO gift_card_products
       (id, subaccount_id, name, status, bg_color1, bg_color2, bg_image_s3_key,
        denominations, custom_amount, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     RETURNING *`,
    [newId, subaccountId, row.name, row.status, row.bg_color1, row.bg_color2,
     row.bg_image_s3_key, row.denominations, row.custom_amount, row.terms]
  );
  return productToFrontend(r.rows[0]);
}

async function archiveProduct(subaccountId, productId) {
  const r = await db.query(
    `UPDATE gift_card_products SET status = 'archived', updated_at = NOW()
      WHERE subaccount_id = $1 AND id = $2 RETURNING *`,
    [subaccountId, productId]
  );
  return productToFrontend(r.rows[0]);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  productToFrontend,
  frontendToRow,
  getAllProducts,
  getProductById,
  upsertProduct,
  archiveProduct
};
