const db = require('./lib/db');
exports.handler = async function () {
  try {
    const r = await db.query(
      `SELECT data->'settings'->'square' AS sq
         FROM subaccount_data
        WHERE subaccount_id = (SELECT id FROM subaccounts WHERE slug='litbiz' LIMIT 1)`
    );
    const sq = r.rows[0]?.sq || {};
    // Redact secrets, just show key names + lengths
    const out = {};
    for (const k of Object.keys(sq)) {
      const v = sq[k];
      if (typeof v === 'string' && v.length > 20) {
        out[k] = `<string, len=${v.length}, prefix=${v.slice(0, 8)}...>`;
      } else {
        out[k] = v;
      }
    }
    return { statusCode: 200, body: JSON.stringify({ keys: Object.keys(sq), values: out }, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
