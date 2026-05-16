// lib/validators.js
// Shared input validators for Lambda endpoints.
//
// Use isValidUuid() before any DB query that interpolates a UUID from
// request body or query string. Postgres rejects malformed UUIDs with
// 22P02 (invalid_text_representation), which previously leaked column
// types via 500 response codes. Validate at the edge instead.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// uid() values are 19-char base36 strings. Loose check; mostly defends
// against accidental nulls/objects/SQL fragments being passed as IDs.
function isValidUid(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(s);
}

function isNonEmptyString(s, maxLen) {
  if (typeof s !== 'string') return false;
  if (s.length === 0) return false;
  if (maxLen && s.length > maxLen) return false;
  return true;
}

// Coerces a money value to NUMERIC-safe 2-decimal string. Returns null if
// the input cannot be safely converted. Use before insert/update of money
// columns.
function coerceMoney(v) {
  if (v === null || v === undefined || v === '') return '0.00';
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n.toFixed(2);
}

module.exports = {
  isValidUuid,
  isValidUid,
  isNonEmptyString,
  coerceMoney
};
