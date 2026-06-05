const db = require('./lib/db');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = 'myspark-booking-widget';
const PREFIX = 'giftcard-art/';
const CDN = 'https://dh460epvdorz0.cloudfront.net/';
const s3 = new S3Client({ region: 'us-east-2' });

exports.handler = async () => {
  const src = await db.query(
    `SELECT subaccount_id, data->'giftCardProducts' AS products
       FROM subaccount_data ORDER BY subaccount_id`
  );

  const results = [];
  for (const row of src.rows) {
    const products = Array.isArray(row.products) ? row.products : [];
    for (const p of products) {
      const rec = { product_id: p.id, subaccount_id: row.subaccount_id };
      const img = p.bgImage || '';
      const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(img);
      if (!m) { rec.action = 'skipped_no_data_url'; results.push(rec); continue; }

      const mime = m[1].toLowerCase();
      const ext = /png/.test(mime) ? 'png' : 'jpg';
      const buf = Buffer.from(m[3], 'base64');
      rec.bytes = buf.length;
      rec.mime = mime;

      if (buf.length > 2 * 1024 * 1024) { rec.action = 'skipped_too_large'; results.push(rec); continue; }

      const key = PREFIX + p.id + '.' + ext;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buf,
          ContentType: mime,
          CacheControl: 'public, max-age=31536000, immutable'
        }));
      } catch (e) {
        rec.action = 'UPLOAD_FAILED';
        rec.error = e.name + ': ' + e.message;
        results.push(rec);
        continue;
      }

      const upd = await db.query(
        `UPDATE gift_card_products SET bg_image_s3_key = $3, updated_at = updated_at
          WHERE subaccount_id = $1 AND id = $2`,
        [row.subaccount_id, p.id, key]
      );
      rec.action = 'uploaded';
      rec.key = key;
      rec.cdn_url = CDN + key;
      rec.db_rows_updated = upd.rowCount;
      results.push(rec);
    }
  }
  return { results };
};
