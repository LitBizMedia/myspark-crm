// api/email/domains/dns-check.js (Lambda version)
//
// POST /api/email/domains/dns-check
//
// Live DNS lookup for each record on a configured domain. Tells the customer
// exactly which records are live and which are still pending or wrong.
//
// Body: { domainId }
//
// Returns: { results: [{type, name, expected, status, actual?, error?}, ...] }
//
// Statuses:
//   live       - DNS resolves AND matches expected value
//   mismatch   - DNS resolves but to a different value (usually a typo)
//   not_found  - DNS doesn't resolve yet (propagation or not added)
//   error      - lookup failed unexpectedly

const db = require('./lib/db');
const dns = require('dns').promises;
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

// Normalize comparison values. DNS often returns trailing dots; we strip them.
// Also lowercases for case-insensitive compare.
function norm(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\.$/, '');
}

// For TXT records, DNS returns array of strings (sometimes split chunks).
// Concatenate them and compare normalized.
function normTxt(strings) {
  if (!strings) return '';
  if (Array.isArray(strings)) return strings.join('').trim();
  return String(strings).trim();
}

async function checkRecord(rec) {
  const type = rec.type;
  const name = rec.name;
  const expected = rec.value;

  try {
    if (type === 'CNAME') {
      const result = await dns.resolveCname(name);
      const actual = result && result.length ? result[0] : null;
      if (!actual) return { status: 'not_found' };
      if (norm(actual) === norm(expected)) {
        return { status: 'live', actual };
      }
      return { status: 'mismatch', actual };
    }

    if (type === 'MX') {
      const result = await dns.resolveMx(name);
      if (!result || !result.length) return { status: 'not_found' };
      const match = result.find(function(r) { return norm(r.exchange) === norm(expected); });
      if (match) return { status: 'live', actual: match.exchange };
      return { status: 'mismatch', actual: result.map(function(r) { return r.exchange; }).join(', ') };
    }

    if (type === 'TXT') {
      const result = await dns.resolveTxt(name);
      if (!result || !result.length) return { status: 'not_found' };
      const flat = result.map(normTxt);
      const expectedNorm = String(expected).trim();

      // Special case: DMARC records. A valid DMARC record is any TXT starting
      // with 'v=DMARC1'. Mailgun, the user's own DMARC tools, or our minimal
      // record all pass. We don't require exact match on policy/reporting.
      if (rec.purpose === 'authentication' && expectedNorm.indexOf('v=DMARC1') === 0) {
        const dmarc = flat.find(function(s) { return s.indexOf('v=DMARC1') === 0; });
        if (dmarc) return { status: 'live', actual: dmarc.length > 60 ? dmarc.slice(0, 60) + '...' : dmarc };
        return { status: 'not_found' };
      }

      // Special case: SPF records. Any TXT starting with 'v=spf1' that includes
      // the expected provider is valid (customer may have extra includes).
      if (expectedNorm.indexOf('v=spf1') === 0) {
        const spf = flat.find(function(s) { return s.indexOf('v=spf1') === 0; });
        if (spf) {
          // Check if expected includes are present
          const m = expectedNorm.match(/include:[\S]+/g) || [];
          const allPresent = m.every(function(inc) { return spf.indexOf(inc) !== -1; });
          if (allPresent) return { status: 'live', actual: spf.length > 60 ? spf.slice(0, 60) + '...' : spf };
          return { status: 'mismatch', actual: spf.length > 60 ? spf.slice(0, 60) + '...' : spf };
        }
        return { status: 'not_found' };
      }

      // Normal exact-match path (DKIM keys, other TXT records)
      const match = flat.find(function(s) { return s === expectedNorm; });
      if (match) return { status: 'live', actual: match };
      // Partial match? Useful diagnostic for users with multi-string TXT issues
      const partial = flat.find(function(s) { return s.indexOf(expectedNorm.slice(0, 20)) !== -1; });
      if (partial) return { status: 'mismatch', actual: partial.length > 60 ? partial.slice(0, 60) + '...' : partial };
      return { status: 'mismatch', actual: flat[0] ? flat[0].slice(0, 60) + '...' : '(unexpected value)' };
    }

    return { status: 'error', error: 'unknown record type: ' + type };

  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
      return { status: 'not_found' };
    }
    return { status: 'error', error: e.message };
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { domainId } = req.body || {};
  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  try {
    const r = await db.query(
      'SELECT * FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2',
      [domainId, auth.subaccount_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const row = r.rows[0];
    const records = Array.isArray(row.dkim_records) ? row.dkim_records : [];

    if (records.length === 0) {
      return res.status(200).json({ results: [] });
    }

    // Run all DNS lookups in parallel
    const checks = await Promise.all(records.map(async function(rec) {
      const result = await checkRecord(rec);
      return Object.assign({ type: rec.type, name: rec.name, expected: rec.value, purpose: rec.purpose }, result);
    }));

    return res.status(200).json({ results: checks });

  } catch (e) {
    console.error('dns-check error:', e.message);
    return res.status(500).json({ error: e.message || 'DNS check failed' });
  }
}

exports.handler = wrap(handler);
