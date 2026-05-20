// api-aws/subaccount/litbiz/whoami.js
// GET /api/subaccount/litbiz/whoami
//
// Lightweight auth check used by standalone HTMLs at /litbiz/*.
// Returns 200 with user identity if requester is a LitBiz subaccount user,
// 403 otherwise. NOT audit logged (page-load noise).

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  try {
    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    return res.status(200).json({
      ok: true,
      user_id: auth.user_id,
      username: auth.username,
      role: auth.role
    });
  } catch (e) {
    console.error('litbiz-whoami error:', e.message);
    return res.status(500).json({ error: 'whoami_failed' });
  }
}

exports.handler = wrap(handler);
