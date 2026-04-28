// api/square/disconnect.js
// Deletes Square credentials for a workspace from the secured table.
// Also clears the connection marker in subaccount_data.

const { deleteSquareCreds } = require('../../lib/square');
const { requireSubaccountAuth, requireAgencyAuth } = require('../../lib/require-subaccount-auth');
const { logAudit } = require('../../lib/audit');
const {
  parseSessionCookie,
  parseAgencySessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function clearSubaccountDataMarker(slug) {
  const subaccountId = 'sub-' + slug;
  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  };
  const getRes = await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId) + '&select=data', { headers: headers });
  if (!getRes.ok) return;
  const rows = await getRes.json();
  if (!Array.isArray(rows) || !rows.length) return;
  const data = rows[0].data || {};
  data.settings = data.settings || {};
  data.settings.square = { appId: '', connected: false, accessToken: '', merchantId: '', locationId: '', sandbox: true };
  await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subaccountId), {
    method: 'PATCH',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: subaccount admin can disconnect their own, agency can disconnect any.
  const subToken = parseSessionCookie(req);
  const agencyToken = parseAgencySessionCookie(req);
  let session = null;
  if (agencyToken) {
    session = await validateSession(agencyToken);
    if (session && session.user_type !== 'agency') session = null;
  }
  if (!session && subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // For subaccount sessions, require admin role (destructive operation)
  if (session.user_type === 'subaccount' && session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required to disconnect Square' });
  }

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  // Subaccount sessions can only access their own slug
  if (session.user_type === 'subaccount' && session.subaccount_id !== ('sub-' + slug)) {
    return res.status(403).json({ error: 'Slug does not match session' });
  }

  const subaccountId = 'sub-' + slug;
  const actorBase = {
    actorType:    session.user_type,
    actorId:       session.user_id,
    actorUsername: session.username,
    actorRole:     session.role
  };

  try {
    await deleteSquareCreds(slug);
    try { await clearSubaccountDataMarker(slug); } catch (e) { console.warn('disconnect: marker clear failed:', e.message); }

    await logAudit({
      req, ...actorBase,
      action: (session.user_type === 'agency') ? 'agency.subaccount.square_disconnect' : 'subaccount.settings.square_disconnect',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { slug: slug }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('disconnect.js error:', err);
    await logAudit({
      req, ...actorBase,
      action: (session.user_type === 'agency') ? 'agency.subaccount.square_disconnect' : 'subaccount.settings.square_disconnect',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: err.message,
      metadata: { slug: slug }
    });
    return res.status(500).json({ error: err.message });
  }
};
