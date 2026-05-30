// api/subaccount/contact-search.js (Lambda version)
//
// GET /api/subaccount/contact-search?q=...&limit=20
//
// Lightweight contact search for picker autocomplete. Returns minimal fields.
// Audit logs query length and result count only (PHI risk if logging raw query).

const { searchContactsForPicker } = require('./lib/contacts');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const q = (req.query && req.query.q) || '';
  const limit = (req.query && req.query.limit) || 20;

  try {
    const { matches, truncated } = await searchContactsForPicker(auth.subaccount_id, q, limit);

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.search',
      targetType: 'contacts',
      targetSubaccountId: auth.subaccount_id,
      metadata: { query_length: q.length, match_count: matches.length, truncated }
    });

    return res.status(200).json({ matches, truncated, query_length: q.length });
  } catch (e) {
    console.error('contact-search error:', e.message);
    return res.status(500).json({ error: 'Search failed: ' + e.message });
  }
}

exports.handler = wrap(handler);
