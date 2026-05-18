// api/subaccount/email-domain-status.js (Lambda version)
// GET /api/subaccount/email-domain-status
//
// Returns the email domain config + derived state for the Settings > Email UI.
//
// Response shape:
//   {
//     mode: 'shared' | 'pending' | 'verifying' | 'verified',
//     domain: { ...db row... } | null,
//     grace_days_remaining: integer,   // 0 if expired
//     grace_period_blocked: boolean,
//     warnings_sent: array of milestone numbers (e.g. [7, 10, 13])
//   }
//
// Mode rules:
//   - 'verified'   = mailgun_domain_id present AND status='verified' AND sending_mode='branded'
//   - 'verifying'  = mailgun_domain_id present AND status='pending'/'verifying'
//   - 'pending'    = row exists but no mailgun_domain_id (stale SES-era or freshly added)
//   - 'shared'    = no row, or row exists with mode='shared' and no mailgun_domain_id

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

function deriveMode(row) {
  if (!row) return 'shared';
  if (row.mailgun_domain_id && row.status === 'verified' && row.sending_mode === 'branded') {
    return 'verified';
  }
  if (row.mailgun_domain_id && row.status !== 'verified') {
    return 'verifying';
  }
  // Stale SES-era rows have no mailgun_domain_id. Treat as shared so the user
  // sees the landing page to add their domain to Mailgun, not a broken records table.
  return 'shared';
}

function daysRemaining(graceEndsAt) {
  if (!graceEndsAt) return 0;
  const end = new Date(graceEndsAt).getTime();
  const now = Date.now();
  const ms = end - now;
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  try {
    const r = await db.query(
      'SELECT * FROM subaccount_email_domains WHERE subaccount_id = $1 ORDER BY created_at DESC LIMIT 1',
      [auth.subaccount_id]
    );
    const row = r.rows[0] || null;

    const response = {
      mode: deriveMode(row),
      domain: row,
      grace_days_remaining: row ? daysRemaining(row.grace_period_ends_at) : 14,
      grace_period_blocked: row ? !!row.grace_period_blocked : false,
      warnings_sent: row && Array.isArray(row.warning_emails_sent) ? row.warning_emails_sent : []
    };

    return res.status(200).json(response);
  } catch (e) {
    console.error('email-domain-status error:', e.message);
    return res.status(500).json({ error: 'Failed to load domain status' });
  }
}

exports.handler = wrap(handler);
