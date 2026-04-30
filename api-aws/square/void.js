// api/square/void.js (Lambda version)
//
// POST /api/square/void
//
// Cancels an authorized but uncaptured payment. Same-day voids only.
//
// MIGRATED: No DB calls of its own.

const { getSquareCreds, squareHost, squareHeaders, sendError } = require('./lib/square');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin','manager'] });
  if (!auth) return;

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();

  if (slug && auth.subaccount_id !== ('sub-' + slug)) {
    return sendError(res, 403, 'Slug does not match session');
  }

  const effectiveSlug = slug || auth.subaccount_id.replace(/^sub-/, '');

  const paymentId = body.paymentId;

  if (!effectiveSlug) return sendError(res, 400, 'Missing slug');
  if (!paymentId) return sendError(res, 400, 'Missing paymentId');

  const creds = await getSquareCreds(effectiveSlug);
  if (!creds || !creds.access_token) {
    return sendError(res, 400, 'Square is not connected for this workspace');
  }

  try {
    const response = await fetch('https://' + squareHost(creds.sandbox) + '/v2/payments/' + encodeURIComponent(paymentId) + '/cancel', {
      method: 'POST',
      headers: squareHeaders(creds.access_token)
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Square API error';
      return sendError(res, response.status, msg, data.errors);
    }
    return res.status(200).json({ success: true, payment: data.payment ? { id: data.payment.id, status: data.payment.status } : null });
  } catch (err) {
    console.error('void.js error:', err);
    return sendError(res, 500, err.message || 'Void failed');
  }
}

exports.handler = wrap(handler);
