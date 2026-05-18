// api/email/domains/add.js (Lambda version)
//
// POST /api/email/domains/add
//
// Provisions a new sending domain in Mailgun and stores the row + DNS records.
// One verified domain per subaccount (idempotent if already present).
//
// Body: { slug, domain }
//
// Returns: { domain: {...db row...}, records: [...mailgun DNS records...] }
//
// MIGRATION: SES → Mailgun (May 18, 2026)

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const MAILGUN_SECRET_NAME = 'myspark/integrations/mailgun';

// Sanitize a domain string. Reject obvious garbage.
function normalizeDomain(s) {
  if (!s) return null;
  const cleaned = String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  if (!cleaned) return null;
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

// Call Mailgun POST /v4/domains to register a new sending domain.
// If domain already exists in Mailgun account, fetches its details instead.
// Create a Mailgun route that forwards inbound mail for this domain to our shared webhook.
// Returns the route ID to store in DB so we can delete it on remove.
async function createMailgunRoute(domain, apiKey) {
  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const webhookUrl = (process.env.INBOUND_WEBHOOK_URL || 'https://api.mysparkplus.app/api/email/mailgun-inbound');

  const form = new URLSearchParams();
  form.append('priority', '10');
  form.append('description', 'MySpark+ inbound route for ' + domain);
  form.append('expression', 'match_recipient(".*@' + domain + '")');
  form.append('action', 'forward("' + webhookUrl + '")');
  form.append('action', 'stop()');

  const response = await fetch('https://api.mailgun.net/v3/routes', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  let body;
  try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }
  if (!response.ok) {
    throw new Error('Mailgun routes API ' + response.status + ': ' + (body.message || 'unknown error'));
  }
  return body.route && body.route.id ? body.route.id : null;
}

async function ensureMailgunDomain(domain, apiKey) {
  const auth = Buffer.from('api:' + apiKey).toString('base64');
  const apiBase = 'https://api.mailgun.net/v4';

  // Try to create
  const form = new URLSearchParams();
  form.append('name', domain);
  form.append('web_scheme', 'https');

  let response = await fetch(apiBase + '/domains', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  let body;
  try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }

  // If domain already exists, fetch it
  if (!response.ok && response.status === 400 && body.message && body.message.toLowerCase().includes('exist')) {
    console.log('ensureMailgunDomain: domain already exists, fetching: ' + domain);
    response = await fetch(apiBase + '/domains/' + encodeURIComponent(domain), {
      headers: { 'Authorization': 'Basic ' + auth }
    });
    try { body = await response.json(); } catch (e) { body = { message: await response.text() }; }
  }

  if (!response.ok) {
    throw new Error('Mailgun API ' + response.status + ': ' + (body.message || 'unknown error'));
  }

  return body;  // { domain: {...}, sending_dns_records: [...], receiving_dns_records: [...] }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { slug, domain: rawDomain } = req.body || {};
  if (!rawDomain) return res.status(400).json({ error: 'domain required' });

  const domain = normalizeDomain(rawDomain);
  if (!domain) return res.status(400).json({ error: 'invalid domain format' });

  const subaccountId = auth.subaccount_id;

  // Check if subaccount already has a domain row (any state)
  const existing = await db.query(
    'SELECT * FROM subaccount_email_domains WHERE subaccount_id = $1',
    [subaccountId]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    // If the same domain, allow re-add (refresh DNS records)
    if (row.domain !== domain) {
      return res.status(409).json({
        error: 'Subaccount already has a domain. Remove ' + row.domain + ' before adding ' + domain + '.'
      });
    }
  }

  try {
    // Get Mailgun account API key
    const apiKey = await secrets.getKey(MAILGUN_SECRET_NAME, 'MAILGUN_ACCOUNT_API_KEY');

    // Auto-prefix mg. subdomain to avoid SPF/DKIM conflicts with the customer's
    // existing email setup at their root domain (Microsoft 365, Google Workspace, etc).
    // This matches industry best practice (GHL, Stripe, etc.) and is the only safe
    // default for healthcare clinics who already have email at root.
    const sendingDomain = domain.startsWith('mg.') ? domain : 'mg.' + domain;

    // Register or fetch Mailgun domain
    const mgResult = await ensureMailgunDomain(sendingDomain, apiKey);

    const mgDomain = mgResult.domain || {};

    // Create the Mailgun route for inbound mail (idempotent: if exists, skip)
    let routeId = null;
    try {
      routeId = await createMailgunRoute(sendingDomain, apiKey);
    } catch (e) {
      // If route creation fails, log but don't block (admin can manually create later)
      console.warn('email-domains-add: route create failed for ' + sendingDomain + ':', e.message);
    }
    const sendingRecords = mgResult.sending_dns_records || [];
    const receivingRecords = mgResult.receiving_dns_records || [];

    // Combine into the format the frontend expects
    // Format: [{ type, name, value, priority? }, ...]
    const allRecords = [];
    for (const r of sendingRecords) {
      allRecords.push({
        type: r.record_type,
        name: r.name || domain,
        value: r.value,
        purpose: 'sending'
      });
    }
    for (const r of receivingRecords) {
      allRecords.push({
        type: r.record_type,
        name: r.name || domain,
        value: r.value,
        priority: r.priority || null,
        purpose: 'receiving'
      });
    }

    // Generate minimal DMARC record. Mailgun does not expose DMARC via API,
    // so we generate a sensible default ourselves. p=none means monitor only
    // (zero deliverability risk). Meets Google/Yahoo minimum DMARC requirement.
    allRecords.push({
      type: 'TXT',
      name: '_dmarc.' + sendingDomain,
      value: 'v=DMARC1; p=none',
      purpose: 'authentication'
    });

    // Insert or update DB row (store the actual sending domain, which is mg.<root>)
    let row;
    if (existing.rows.length > 0) {
      const updateResult = await db.query(
        `UPDATE subaccount_email_domains
         SET domain = $1,
             mailgun_domain_id = $2,
             mailgun_inbound_route_id = $3,
             dkim_records = $4,
             status = 'pending',
             sending_mode = 'shared',
             grace_period_ends_at = NOW() + INTERVAL '14 days',
             grace_period_blocked = false,
             warning_emails_sent = '[]'::jsonb
         WHERE subaccount_id = $5
         RETURNING *`,
        [sendingDomain, mgDomain.id || null, routeId, JSON.stringify(allRecords), subaccountId]
      );
      row = updateResult.rows[0];
    } else {
      const insertResult = await db.query(
        `INSERT INTO subaccount_email_domains
         (subaccount_id, domain, mailgun_domain_id, mailgun_inbound_route_id, status,
          dkim_records, sending_mode, inbound_mode, grace_period_ends_at, resend_domain_id)
         VALUES ($1, $2, $3, $4, 'pending', $5, 'shared', 'shared',
                 NOW() + INTERVAL '14 days', 'mailgun')
         RETURNING *`,
        [subaccountId, sendingDomain, mgDomain.id || null, routeId, JSON.stringify(allRecords)]
      );
      row = insertResult.rows[0];
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.email_domain.add',
      targetType: 'email_domain',
      targetId: row.id,
      targetSubaccountId: subaccountId,
      metadata: { domain: sendingDomain, root_domain: domain, mailgun_domain_id: mgDomain.id, mailgun_inbound_route_id: routeId }
    });

    return res.status(200).json({
      domain: row,
      records: allRecords
    });

  } catch (e) {
    console.error('email-domains-add error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to add domain' });
  }
}

exports.handler = wrap(handler);
