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

// Resolve one record. Returns { status, actual?, error? }.
async function checkRecord(rec) {
  const type = rec.type;
  const name = rec.name;
  const expected = rec.value;

  try {
    if (type === 'CNAME') {
      const result = await dns.resolveCname(name);
      // resolveCname returns array of CNAME targets
      const actual = result && result.length ? result[0] : null;
      if (!actual) return { status: 'not_found' };
      if (norm(actual) === norm(expected)) {
        return { status: 'live', actual };
      }
      return { status: 'mismatch', actual };
    }

    if (type === 'MX') {
      const result = await dns.resolveMx(name);
      // returns array of {exchange, priority}
      if (!result || !result.length) return { status: 'not_found' };
      const match = result.find(function(r) { return norm(r.exchange) === norm(expected); });
      if (match) {
        return { status: 'live', actual: match.exchange + ' (priority ' + match.priority + ')' };
      }
      return { status: 'mismatch', actual: result.map(function(r) { return r.exchange; }).join(', ') };
    }

    if (type === 'TXT') {
      const result = await dns.resolveTxt(name);
      // returns array of arrays of strings (DNS chunks each TXT into 255-char segments)
      if (!result || !result.length) return { status: 'not_found' };
      const joined = result.map(function(arr) { return arr.join(''); });
      const expectedNorm = norm(expected);

      // Exact match
      const exactMatch = joined.find(function(s) { return norm(s) === expectedNorm; });
      if (exactMatch) {
        return { status: 'live', actual: exactMatch };
      }

      // SPF semantic match: existing record contains our include
      if (expectedNorm.indexOf('v=spf1') === 0) {
        const spfRec = joined.find(function(s) { return s.toLowerCase().indexOf('v=spf1') === 0; });
        if (spfRec) {
          if (spfRec.toLowerCase().indexOf('include:amazonses.com') !== -1) {
            return { status: 'live', actual: spfRec };
          }
          // SPF record exists but doesn't include amazonses.com - mismatch with actionable hint
          return { status: 'mismatch', actual: spfRec };
        }
      }

      // DMARC semantic match: any valid v=DMARC1 record with a p= policy counts as live
      if (expectedNorm.indexOf('v=dmarc1') === 0) {
        const dmarcRec = joined.find(function(s) { return s.toLowerCase().indexOf('v=dmarc1') === 0; });
        if (dmarcRec && /p\s*=/i.test(dmarcRec)) {
          return { status: 'live', actual: dmarcRec };
        }
      }

      return { status: 'mismatch', actual: joined[0] };
    }

    return { status: 'error', error: 'Unsupported record type: ' + type };
  } catch (e) {
    // dns module throws with err.code === 'ENOTFOUND' or 'ENODATA' when no record exists
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { status: 'not_found' };
    return { status: 'error', error: e.message || String(e) };
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const body = req.body || {};
  const domainId = body.domainId;

  if (!domainId) return res.status(400).json({ error: 'domainId required' });

  try {
    const rowQ = await db.query(
      `SELECT id, domain, dkim_records FROM subaccount_email_domains WHERE id = $1 AND subaccount_id = $2`,
      [domainId, subaccountId]
    );
    if (!rowQ.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const records = rowQ.rows[0].dkim_records || [];
    if (!Array.isArray(records) || !records.length) {
      return res.status(200).json({ results: [] });
    }

    // Run all checks in parallel
    const results = await Promise.all(records.map(async function(rec) {
      const check = await checkRecord(rec);
      return Object.assign({
        type: rec.type,
        name: rec.name,
        expected: rec.value,
        group: rec.group,
        label: rec.label,
        priority: rec.priority
      }, check);
    }));

    return res.status(200).json({ results });
  } catch (err) {
    console.error('dns-check error:', err);
    return res.status(500).json({ error: err.message || 'DNS check failed' });
  }
}

exports.handler = wrap(handler);
