// POST /api/subaccount/contact-bulk-check-emails
//
// Takes an array of emails, returns which ones already exist as contacts
// in the subaccount. Used by CSV import dedup to avoid the load-all-contacts
// pattern (which silently broke after Stage 2 pagination).
//
// Body:
//   { emails: ["a@x.com", "b@y.com", ...] }  // 1-2000 emails per request
//
// Response:
//   {
//     existing: {
//       "a@x.com": { id, name, email },
//       "b@y.com": { id, name, email }
//     },
//     checked: 2,
//     found: 2
//   }
//
// Emails matched case-insensitively against contacts.email (LOWER).
// Existing index idx_contacts_email_lookup handles this efficiently.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const MAX_EMAILS = 2000;

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const emails = Array.isArray(body && body.emails) ? body.emails : null;
  if (!emails) return res.status(400).json({ error: 'Missing emails array' });
  if (emails.length === 0) {
    return res.status(200).json({ existing: {}, checked: 0, found: 0 });
  }
  if (emails.length > MAX_EMAILS) {
    return res.status(400).json({ error: 'Too many emails. Max ' + MAX_EMAILS + ' per request.' });
  }

  // Normalize: lowercase, trim, filter empties and obvious junk
  const normalized = [];
  const normSet = new Set();
  emails.forEach(function (e) {
    if (typeof e !== 'string') return;
    const v = e.trim().toLowerCase();
    if (!v || v.indexOf('@') < 0) return;
    if (normSet.has(v)) return;
    normSet.add(v);
    normalized.push(v);
  });

  if (normalized.length === 0) {
    return res.status(200).json({ existing: {}, checked: 0, found: 0 });
  }

  try {
    // Single query with ANY() for efficiency. Uses idx_contacts_email_lookup.
    const result = await db.query(
      `SELECT id, display_name, email
       FROM contacts
       WHERE subaccount_id = $1
         AND LOWER(email) = ANY($2)
         AND archived = FALSE`,
      [subaccountId, normalized]
    );

    const existing = {};
    result.rows.forEach(function (r) {
      if (!r.email) return;
      const key = r.email.toLowerCase().trim();
      // Keep first match (RDS guarantees unique-ish but defensive)
      if (!existing[key]) {
        existing[key] = {
          id: r.id,
          name: r.display_name,
          email: r.email
        };
      }
    });

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.contact.bulk_check_emails',
      targetType: 'bulk_data',
      targetSubaccountId: subaccountId,
      metadata: {
        checked: normalized.length,
        found: result.rowCount
      }
    });

    return res.status(200).json({
      existing: existing,
      checked: normalized.length,
      found: result.rowCount
    });
  } catch (err) {
    console.error('contact-bulk-check-emails error:', err);
    return res.status(500).json({ error: 'Bulk check failed', detail: err.message });
  }
}

exports.handler = wrap(handler);
