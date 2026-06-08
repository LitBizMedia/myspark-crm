// lib/gift-cards.js
//
// Shared gift card accessor for backend Lambdas.
//
// Single source of truth for backend gift card reads/writes. Mirrors the
// lib/coupons.js pattern: snake_case rows in, camelCase out via
// giftCardToFrontend; money mutations run inside db.transaction with a
// SELECT ... FOR UPDATE row lock so balance changes are atomic.
//
// The per-card audit trail lives in the gift_card_log child table, NOT inline.
// List/find reads attach an empty log:[] for shape compatibility; the real
// history is hydrated on demand via getCardLog().
//
// Money rules (per MySpark Payment Policy):
//   - balance never goes negative (redeem validates balance >= amount)
//   - status set server-side: balance<=0 -> 'redeemed', else 'partial'
//   - cannot redeem a 'refunded' or 'voided' card
//   - every mutation writes a gift_card_log row in the SAME transaction
//
// USAGE:
//   const gc = require('./lib/gift-cards');
//   const card = await gc.findByCode(subaccountId, 'Y2WF-4XML-9FQY');

const db = require('./db');
const { getContactByEmail } = require('./contacts');

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

// gift_cards row (snake_case) -> camelCase shape the frontend expects.
// Byte-compatible with the legacy blob card shape. squarePaymentId maps NULL
// back to '' to match the old blob (which stored '' for no Square charge).
function giftCardToFrontend(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    productId: row.product_id || null,
    contactId: row.contact_id || null,
    recipientName: row.recipient_name || null,
    recipientEmail: row.recipient_email || null,
    recipientContactId: row.recipient_contact_id || null,
    isDigital: !!row.is_digital,
    originalAmount: row.original_amount != null ? Number(row.original_amount) : 0,
    balance: row.balance != null ? Number(row.balance) : 0,
    status: row.status,
    issuedById: row.issued_by_id || null,
    soldVia: row.sold_via || null,
    paymentId: row.payment_id || null,
    paymentMethod: row.payment_method || null,
    squarePaymentId: row.square_payment_id || '',
    issuedAt: tsToIso(row.issued_at),
    log: [], // hydrated on demand via getCardLog
    createdAt: tsToIso(row.created_at),
    updatedAt: tsToIso(row.updated_at)
  };
}

// gift_card_log row -> camelCase entry matching the legacy inline log shape:
// { type, amount, note, date, contactId, paymentId }
function logEntryToFrontend(row) {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : null,
    type: row.entry_type,
    amount: row.amount != null ? Number(row.amount) : 0,
    note: row.note || '',
    date: tsToIso(row.created_at),
    contactId: row.contact_id || null,
    paymentId: row.payment_id || null,
    staffId: row.staff_id || null
  };
}

// pg returns TIMESTAMPTZ as JS Date. Frontend expects ISO strings (or null).
function tsToIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Single card by id (scoped to subaccount). log empty; hydrate via getCardLog.
async function findById(subaccountId, id) {
  const r = await db.query(
    `SELECT * FROM gift_cards WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, id]
  );
  return giftCardToFrontend(r.rows[0]);
}

// Single card by code, case-insensitive. Redemption hot path (POS apply).
async function findByCode(subaccountId, code) {
  const r = await db.query(
    `SELECT * FROM gift_cards WHERE subaccount_id = $1 AND UPPER(code) = UPPER($2)`,
    [subaccountId, String(code || '').trim()]
  );
  return giftCardToFrontend(r.rows[0]);
}

// All cards for a contact (purchaser), newest first.
async function listByContact(subaccountId, contactId) {
  if (!contactId) return [];
  const r = await db.query(
    `SELECT * FROM gift_cards
      WHERE subaccount_id = $1 AND contact_id = $2
      ORDER BY issued_at DESC`,
    [subaccountId, contactId]
  );
  return r.rows.map(giftCardToFrontend);
}

// Paginated list with optional status/contact filter.
// Returns { cards, total, page, pageSize, totalPages }.
async function listBySubaccount(subaccountId, opts) {
  opts = opts || {};
  const where = ['subaccount_id = $1'];
  const params = [subaccountId];
  let p = 2;
  if (opts.status) { where.push(`status = $${p++}`); params.push(opts.status); }
  if (opts.contactId) { where.push(`contact_id = $${p++}`); params.push(opts.contactId); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const countR = await db.query(`SELECT COUNT(*)::int AS n FROM gift_cards ${whereSql}`, params);
  const total = countR.rows[0] ? countR.rows[0].n : 0;

  const page = Math.max(1, parseInt(opts.page || 1, 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize || 50, 10)));
  const offset = (page - 1) * pageSize;

  const listR = await db.query(
    `SELECT * FROM gift_cards ${whereSql}
      ORDER BY issued_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
    [...params, pageSize, offset]
  );
  return {
    cards: listR.rows.map(giftCardToFrontend),
    total, page, pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

// Boolean: does this subaccount have any spendable card? Powers UI gating
// (show "pay with gift card" only when true).
async function hasActive(subaccountId) {
  const r = await db.query(
    `SELECT 1 FROM gift_cards
      WHERE subaccount_id = $1 AND status IN ('active','partial') AND balance > 0
      LIMIT 1`,
    [subaccountId]
  );
  return r.rows.length > 0;
}

// Full history for one card, newest first.
async function getCardLog(subaccountId, giftCardId) {
  const r = await db.query(
    `SELECT * FROM gift_card_log
      WHERE subaccount_id = $1 AND gift_card_id = $2
      ORDER BY created_at DESC, id DESC`,
    [subaccountId, giftCardId]
  );
  return r.rows.map(logEntryToFrontend);
}

// Issued count + outstanding balance per product. Powers products/stats.
async function statsByProduct(subaccountId) {
  const r = await db.query(
    `SELECT product_id,
            COUNT(*)::int AS issued_count,
            COALESCE(SUM(balance),0)::numeric AS outstanding_balance
       FROM gift_cards
      WHERE subaccount_id = $1
      GROUP BY product_id`,
    [subaccountId]
  );
  const out = {};
  for (const row of r.rows) {
    out[row.product_id || '_none'] = {
      issuedCount: row.issued_count,
      outstandingBalance: Number(row.outstanding_balance)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes (money) - all atomic via db.transaction + FOR UPDATE
// ---------------------------------------------------------------------------

// Issue a new card (sale flow). Inserts the card AND its 'issued' log entry in
// one transaction. Enforces code uniqueness per subaccount with retry on
// collision (no DB unique constraint; codes are app-generated).
//
// opts: {
//   id?, code?, productId, contactId, recipientName, recipientEmail, isDigital,
//   originalAmount, balance?, issuedById, soldVia, paymentId, paymentMethod,
//   squarePaymentId, issuedAt?, note?
// }
// Create a card using an existing transaction client. Inserts the card plus
// its 'issued' log row. Used by payments-create on a gift card SALE so the card
// and its sale payment commit together. Mirrors createCard's body.
// Resolve the recipient-as-contact link. MATCH-ONLY: link to an existing
// contact when the recipient email matches one in this subaccount; never create.
// An explicit opts.recipientContactId wins. Reads committed contact data
// (separate connection is fine; the contact already exists).
async function _resolveRecipientContactId(subaccountId, opts) {
  if (opts.recipientContactId) return opts.recipientContactId;
  if (!opts.recipientEmail) return null;
  try {
    const c = await getContactByEmail(subaccountId, opts.recipientEmail);
    return c ? c.id : null;
  } catch (e) {
    console.warn('gift-cards: recipient contact match failed (non-fatal):', e.message);
    return null;
  }
}

async function _createOnClient(client, subaccountId, opts) {
  const id = (opts.id && /^gc-/.test(opts.id)) ? opts.id : ('gc-' + genId());
  const original = Number(opts.originalAmount);
  if (!(original > 0)) throw new Error('createCard: originalAmount must be > 0');
  const balance = opts.balance != null ? Number(opts.balance) : original;
  const code = await uniqueCode(client, subaccountId, opts.code);
  const issuedAt = opts.issuedAt || new Date().toISOString();
  const recipientContactId = await _resolveRecipientContactId(subaccountId, opts);

  const ins = await client.query(
    `INSERT INTO gift_cards
       (id, subaccount_id, code, product_id, contact_id, recipient_name,
        recipient_email, recipient_contact_id, is_digital, original_amount, balance, status,
        issued_by_id, sold_via, payment_id, payment_method, square_payment_id,
        issued_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$17,NOW())
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id, subaccountId, code, opts.productId || null, opts.contactId || null,
     opts.recipientName || null, opts.recipientEmail || null, recipientContactId, !!opts.isDigital,
     original, balance, opts.issuedById || null, opts.soldVia || null,
     opts.paymentId || null, opts.paymentMethod || null,
     opts.squarePaymentId || null, issuedAt]
  );
  if (ins.rowCount === 1) {
    await client.query(
      `INSERT INTO gift_card_log
         (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id, created_at)
       VALUES ($1,$2,'issued',$3,$4,$5,$6,$7,$8)`,
      [id, subaccountId, original,
       opts.note || ('Issued via ' + (opts.soldVia || 'sale')),
       opts.contactId || null, opts.paymentId || null, opts.issuedById || null,
       issuedAt]
    );
  }
  return giftCardToFrontend(ins.rows[0] || null);
}

async function createCard(subaccountId, opts) {
  const id = (opts.id && /^gc-/.test(opts.id)) ? opts.id : ('gc-' + genId());
  const original = Number(opts.originalAmount);
  if (!(original > 0)) throw new Error('createCard: originalAmount must be > 0');
  const balance = opts.balance != null ? Number(opts.balance) : original;

  return db.transaction(async (client) => {
    const code = await uniqueCode(client, subaccountId, opts.code);
    const issuedAt = opts.issuedAt || new Date().toISOString();
    const recipientContactId = await _resolveRecipientContactId(subaccountId, opts);

    const ins = await client.query(
      `INSERT INTO gift_cards
         (id, subaccount_id, code, product_id, contact_id, recipient_name,
          recipient_email, recipient_contact_id, is_digital, original_amount, balance, status,
          issued_by_id, sold_via, payment_id, payment_method, square_payment_id,
          issued_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$17,NOW())
       RETURNING *`,
      [id, subaccountId, code, opts.productId || null, opts.contactId || null,
       opts.recipientName || null, opts.recipientEmail || null, recipientContactId, !!opts.isDigital,
       original, balance, opts.issuedById || null, opts.soldVia || null,
       opts.paymentId || null, opts.paymentMethod || null,
       opts.squarePaymentId || null, issuedAt]
    );

    await client.query(
      `INSERT INTO gift_card_log
         (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id, created_at)
       VALUES ($1,$2,'issued',$3,$4,$5,$6,$7,$8)`,
      [id, subaccountId, original,
       opts.note || ('Issued via ' + (opts.soldVia || 'sale')),
       opts.contactId || null, opts.paymentId || null, opts.issuedById || null,
       issuedAt]
    );

    return giftCardToFrontend(ins.rows[0]);
  });
}

// Redeem (deduct) balance. Validates the card is spendable and balance covers
// the amount, then deducts, sets status, and logs the redemption in one txn.
//
// opts: { giftCardId, amount, note?, contactId?, paymentId?, staffId? }
// Returns { ok, balance, status } or { ok:false, reason }.
// Deduct using an existing transaction client. Locks the card row, validates,
// deducts, sets status, writes the redeem log. Throws on a real failure so the
// caller's transaction rolls back; returns {ok:false,reason} for business
// rejections (not found / insufficient / wrong status) WITHOUT throwing, so the
// caller can decide whether to roll back. payments-create treats !ok as fatal
// (throws to roll back the payment); standalone deductBalance maps it to a response.
//
// lookupBy: 'id' (default) or 'code'. POS/appointment/pack send the code on the
// payment, so payments-create looks up by code.
async function _deductOnClient(client, subaccountId, opts) {
  const amount = Number(opts.amount);
  if (!(amount > 0)) return { ok: false, reason: 'bad_amount' };

  let sel;
  if (opts.lookupBy === 'code') {
    sel = await client.query(
      `SELECT * FROM gift_cards
        WHERE subaccount_id = $1 AND UPPER(code) = UPPER($2) FOR UPDATE`,
      [subaccountId, String(opts.code || '').trim()]
    );
  } else {
    sel = await client.query(
      `SELECT * FROM gift_cards
        WHERE subaccount_id = $1 AND id = $2 FOR UPDATE`,
      [subaccountId, opts.giftCardId]
    );
  }
  const card = sel.rows[0];
  if (!card) return { ok: false, reason: 'not_found' };
  if (card.status === 'voided' || card.status === 'refunded') {
    return { ok: false, reason: 'card_' + card.status };
  }
  const bal = Number(card.balance);
  if (bal < amount) return { ok: false, reason: 'insufficient_balance', balance: bal };

  const newBal = round2(bal - amount);
  const newStatus = newBal <= 0 ? 'redeemed' : 'partial';

  await client.query(
    `UPDATE gift_cards SET balance = $3, status = $4, updated_at = NOW()
      WHERE subaccount_id = $1 AND id = $2`,
    [subaccountId, card.id, newBal, newStatus]
  );
  await client.query(
    `INSERT INTO gift_card_log
       (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id)
     VALUES ($1,$2,'redeem',$3,$4,$5,$6,$7)`,
    [card.id, subaccountId, amount,
     opts.note || 'Redeemed', opts.contactId || null,
     opts.paymentId || null, opts.staffId || null]
  );
  return { ok: true, giftCardId: card.id, balance: newBal, status: newStatus };
}

async function deductBalance(subaccountId, opts) {
  const amount = Number(opts.amount);
  if (!(amount > 0)) return { ok: false, reason: 'bad_amount' };
  return db.transaction(async (client) => _deductOnClient(client, subaccountId, opts));
}

// Restore balance (refund of a prior redemption). Adds back, capped at
// originalAmount, sets status 'active' when balance > 0, logs a refund entry.
//
// opts: { giftCardId, amount, note?, contactId?, paymentId?, staffId? }
async function restoreBalance(subaccountId, opts) {
  return _addToBalance(subaccountId, opts, 'refund', 'Refunded to gift card');
}

// Manual credit add (admin tops up a card). Logs a credit entry.
async function addCredit(subaccountId, opts) {
  return _addToBalance(subaccountId, opts, 'credit', 'Manual credit');
}

async function _addToBalance(subaccountId, opts, entryType, defaultNote) {
  const amount = Number(opts.amount);
  if (!(amount > 0)) return { ok: false, reason: 'bad_amount' };

  return db.transaction(async (client) => {
    const r = await client.query(
      `SELECT * FROM gift_cards
        WHERE subaccount_id = $1 AND id = $2 FOR UPDATE`,
      [subaccountId, opts.giftCardId]
    );
    const card = r.rows[0];
    if (!card) return { ok: false, reason: 'not_found' };
    if (card.status === 'voided') return { ok: false, reason: 'card_voided' };

    const original = Number(card.original_amount);
    let newBal = round2(Number(card.balance) + amount);
    // refund restore is capped at original; manual credit may exceed it.
    if (entryType === 'refund' && newBal > original) newBal = original;
    const newStatus = newBal > 0 ? 'active' : card.status;

    await client.query(
      `UPDATE gift_cards SET balance = $3, status = $4, updated_at = NOW()
        WHERE subaccount_id = $1 AND id = $2`,
      [subaccountId, opts.giftCardId, newBal, newStatus]
    );
    await client.query(
      `INSERT INTO gift_card_log
         (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [opts.giftCardId, subaccountId, entryType, amount,
       opts.note || defaultNote, opts.contactId || null,
       opts.paymentId || null, opts.staffId || null]
    );
    return { ok: true, balance: newBal, status: newStatus };
  });
}

// Admin void. Zeroes the balance, sets status 'voided', logs a void entry for
// the amount that was outstanding.
//
// opts: { giftCardId, note?, staffId? }
async function voidCard(subaccountId, opts) {
  return db.transaction(async (client) => {
    const r = await client.query(
      `SELECT * FROM gift_cards
        WHERE subaccount_id = $1 AND id = $2 FOR UPDATE`,
      [subaccountId, opts.giftCardId]
    );
    const card = r.rows[0];
    if (!card) return { ok: false, reason: 'not_found' };
    if (card.status === 'voided') return { ok: true, balance: 0, status: 'voided' };

    const outstanding = Number(card.balance);
    await client.query(
      `UPDATE gift_cards SET balance = 0, status = 'voided', updated_at = NOW()
        WHERE subaccount_id = $1 AND id = $2`,
      [subaccountId, opts.giftCardId]
    );
    await client.query(
      `INSERT INTO gift_card_log
         (gift_card_id, subaccount_id, entry_type, amount, note, staff_id)
       VALUES ($1,$2,'void',$3,$4,$5)`,
      [opts.giftCardId, subaccountId, outstanding,
       opts.note || 'Card voided', opts.staffId || null]
    );
    return { ok: true, balance: 0, status: 'voided' };
  });
}

// Set status directly (escape hatch; prefer the specific ops above).
async function updateStatus(subaccountId, giftCardId, status) {
  const allowed = ['active', 'partial', 'redeemed', 'refunded', 'voided'];
  if (!allowed.includes(status)) throw new Error('updateStatus: bad status ' + status);
  const r = await db.query(
    `UPDATE gift_cards SET status = $3, updated_at = NOW()
      WHERE subaccount_id = $1 AND id = $2 RETURNING *`,
    [subaccountId, giftCardId, status]
  );
  return giftCardToFrontend(r.rows[0]);
}

// Standalone log insert (rarely needed; createCard/deduct/restore log inline).
// opts: { giftCardId, entryType, amount, note?, contactId?, paymentId?, staffId?, date? }
async function logEntry(subaccountId, opts) {
  const r = await db.query(
    `INSERT INTO gift_card_log
       (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, NOW()))
     RETURNING *`,
    [opts.giftCardId, subaccountId, opts.entryType, Number(opts.amount || 0),
     opts.note || null, opts.contactId || null, opts.paymentId || null,
     opts.staffId || null, opts.date || null]
  );
  return logEntryToFrontend(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Ensure a unique code within the subaccount. If the supplied code collides (or
// none supplied), generate until free. Runs inside the caller's txn client.
async function uniqueCode(client, subaccountId, wanted) {
  let code = (wanted && String(wanted).trim()) || genCode();
  for (let i = 0; i < 8; i++) {
    const c = await client.query(
      `SELECT 1 FROM gift_cards WHERE subaccount_id = $1 AND UPPER(code) = UPPER($2) LIMIT 1`,
      [subaccountId, code]
    );
    if (!c.rows.length) return code;
    code = genCode(); // collision: regenerate (ignores the wanted value)
  }
  throw new Error('uniqueCode: could not find a free code after 8 tries');
}

// Card code format: XXXX-XXXX-XXXX (A-Z0-9, no ambiguous chars).
function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const block = () => Array.from({ length: 4 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return block() + '-' + block() + '-' + block();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Matches the frontend uid() entropy. Ids are namespaced (gc-) and per-subaccount.
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  giftCardToFrontend,
  logEntryToFrontend,
  findById,
  findByCode,
  listByContact,
  listBySubaccount,
  hasActive,
  getCardLog,
  statsByProduct,
  createCard,
  deductBalance,
  _deductOnClient,
  _createOnClient,
  restoreBalance,
  addCredit,
  voidCard,
  updateStatus,
  logEntry,
  genCode
};
