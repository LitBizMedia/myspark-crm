// lib-aws/phone.js
// Canonical phone normalization. Single source of truth.
// Returns an E.164 string, or null on bad/empty input.

function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already E.164
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  // 10-digit US format
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

module.exports = { normalizePhone };
