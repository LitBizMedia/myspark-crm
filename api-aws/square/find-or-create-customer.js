// api/square/find-or-create-customer.js (Lambda version)
//
// POST /api/square/find-or-create-customer
//
// Finds existing Square customer by email or creates new one.
// Returns { customerId, action }.
//
// MIGRATED: No DB calls of its own - delegates to lib/square.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./lib/square');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) return sendError(res, 401, 'Not authenticated');

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const phone = (body.phone || '').toString().trim();

  if (!slug) return sendError(res, 400, 'Missing slug');

  if (session.user_type === 'subaccount' && session.subaccount_id !== ('sub-' + slug)) {
    return sendError(res, 403, 'Slug does not match session');
  }

  if (!name && !email && !phone) return sendError(res, 400, 'At least one of name, email, phone is required');

  const creds = await getSquareCreds(slug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  const host = squareHost(creds.sandbox);
  const headers = squareHeaders(creds.access_token);

  try {
    if (email) {
      const searchRes = await fetch('https://' + host + '/v2/customers/search', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ query: { filter: { email_address: { exact: email } } }, limit: 1 })
      });
      const searchData = await searchRes.json();
      if (searchRes.ok && Array.isArray(searchData.customers) && searchData.customers.length) {
        return res.status(200).json({ customerId: searchData.customers[0].id, action: 'found' });
      }
    }

    const parts = name.split(/\s+/);
    const givenName = parts[0] || '';
    const familyName = parts.slice(1).join(' ') || '';
    const createBody = {};
    if (givenName) createBody.given_name = givenName;
    if (familyName) createBody.family_name = familyName;
    if (email) createBody.email_address = email;
    if (phone) createBody.phone_number = phone;

    const createRes = await fetch('https://' + host + '/v2/customers', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(createBody)
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      const msg = (createData.errors && createData.errors[0] && createData.errors[0].detail) || 'Square API error';
      return sendError(res, createRes.status, msg, createData.errors);
    }
    return res.status(200).json({ customerId: createData.customer && createData.customer.id, action: 'created' });
  } catch (err) {
    console.error('find-or-create-customer.js error:', err);
    return sendError(res, 500, err.message || 'Customer lookup failed');
  }
}

exports.handler = wrap(handler);
