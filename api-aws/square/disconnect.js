// api/square/disconnect.js (Lambda version)
//
// POST /api/square/disconnect
//
// Deletes Square credentials and clears connection marker in subaccount_data.
//
// MIGRATED: Supabase REST → lib/db.js for subaccount_data marker writes.

const db = require('./lib/db');
const { deleteSquareCreds } = require('./lib/square');
const { logAudit } = require('./lib/audit');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

async function clearSubaccountDataMarker(slug) {
  const subaccountId = 'sub-' + slug;
  
  let row;
  try {
    row = await db.findOne('subaccount_data',
      { subaccount_id: subaccountId },
      { select: 'data' }
    );
  } catch (e) {
    return;
  }
  
  if (!row) return;
  
  const data = row.data || {};
  data.settings = data.settings || {};
  data.settings.square = { appId: '', connected: false, accessToken: '', merchantId: '', locationId: '', sandbox: true };
  
  await db.update('subaccount_data',
    { data: data, updated_at: new Date().toISOString() },
    { subaccount_id: subaccountId }
  );
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const subToken = parseSessionCookie(req);
  let session = null;
  if (subToken) {
    session = await validateSession(subToken);
    if (session && session.user_type !== 'subaccount') session = null;
  }
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (session.user_type === 'subaccount' && session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required to disconnect Square' });
  }

  const body = req.body || {};
  const slug = (body.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

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
      action: 'subaccount.settings.square_disconnect',
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
      action: 'subaccount.settings.square_disconnect',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      outcome: 'failure',
      errorMessage: err.message,
      metadata: { slug: slug }
    });
    return res.status(500).json({ error: err.message });
  }
}

exports.handler = wrap(handler);
