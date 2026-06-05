const db = require('./lib/db');

exports.handler = async () => {
  const src = await db.query(
    `SELECT subaccount_id,
            data->'giftCards' AS cards,
            data->'giftCardProducts' AS products
       FROM subaccount_data
      ORDER BY subaccount_id`
  );

  const result = { products_inserted: 0, cards_inserted: 0, log_rows_inserted: 0, per_sub: [] };

  await db.transaction(async (client) => {
    for (const row of src.rows) {
      const subId = row.subaccount_id;            // sub-X (the real FK)
      const products = Array.isArray(row.products) ? row.products : [];
      const cards = Array.isArray(row.cards) ? row.cards : [];
      const subSummary = { subaccount_id: subId, products: 0, cards: 0, log_rows: 0 };

      // --- products first (FK parent) ---
      for (const p of products) {
        const denom = JSON.stringify(Array.isArray(p.denominations) ? p.denominations : []);
        const ins = await client.query(
          `INSERT INTO gift_card_products
             (id, subaccount_id, name, status, bg_color1, bg_color2, bg_image_s3_key,
              denominations, custom_amount, terms, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,$7::jsonb,$8,$9,
                   COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW()))
           ON CONFLICT (id) DO NOTHING`,
          [p.id, subId, p.name || 'Gift Card', p.status === 'archived' ? 'archived' : 'active',
           p.bgColor1 || '#6b21ea', p.bgColor2 || '#ff4000', denom,
           !!p.customAmount, p.terms || null, p.createdAt || null, p.updatedAt || null]
        );
        subSummary.products += ins.rowCount;
      }

      // --- cards next ---
      for (const c of cards) {
        const sq = c.squarePaymentId ? c.squarePaymentId : null;
        const ins = await client.query(
          `INSERT INTO gift_cards
             (id, subaccount_id, code, product_id, contact_id, recipient_name,
              recipient_email, is_digital, original_amount, balance, status,
              issued_by_id, sold_via, payment_id, payment_method, square_payment_id,
              issued_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,FALSE,$7,$8,$9,$10,$11,$12,$13,$14,
                   COALESCE($15::timestamptz, NOW()), COALESCE($15::timestamptz, NOW()), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [c.id, subId, c.code, c.productId || null, c.contactId || null,
           c.recipientName || null,
           Number(c.originalAmount), Number(c.balance),
           c.status || 'active', c.issuedById || null, c.soldVia || null,
           c.paymentId || null, c.paymentMethod || null, sq, c.issuedAt || null]
        );
        subSummary.cards += ins.rowCount;

        // --- log rows for this card (only if the card was newly inserted) ---
        if (ins.rowCount === 1) {
          const log = Array.isArray(c.log) ? c.log : [];
          for (const e of log) {
            const lr = await client.query(
              `INSERT INTO gift_card_log
                 (gift_card_id, subaccount_id, entry_type, amount, note, contact_id, payment_id, staff_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()))`,
              [c.id, subId, e.type, Number(e.amount), e.note || null,
               e.contactId || null, e.paymentId || null, null, e.date || null]
            );
            subSummary.log_rows += lr.rowCount;
          }
        }
      }

      result.products_inserted += subSummary.products;
      result.cards_inserted += subSummary.cards;
      result.log_rows_inserted += subSummary.log_rows;
      result.per_sub.push(subSummary);
    }
  });

  // --- read back everything for the verify gate ---
  const cardsBack = await db.query(
    `SELECT id, subaccount_id, code, product_id, contact_id, original_amount,
            balance, status, sold_via, payment_method, square_payment_id,
            issued_at, created_at
       FROM gift_cards ORDER BY subaccount_id, issued_at`
  );
  const logBack = await db.query(
    `SELECT gift_card_id, entry_type, amount, note, contact_id, created_at
       FROM gift_card_log ORDER BY gift_card_id, created_at`
  );
  const prodBack = await db.query(
    `SELECT id, subaccount_id, name, status, bg_image_s3_key, denominations,
            custom_amount, created_at, updated_at
       FROM gift_card_products ORDER BY subaccount_id`
  );

  return {
    summary: result,
    readback: {
      products: prodBack.rows,
      cards: cardsBack.rows,
      log: logBack.rows
    }
  };
};
