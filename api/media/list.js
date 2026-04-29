// api/media/list.js
// Lists media files for the current subaccount with presigned GET URLs.
// Supports folder filter and search query.
//
// Security:
//   - Auth: subaccount session required
//   - Role admin or manager (matches who can access the panel)
//   - Subaccount slug isolation: query filters by session.subaccount_id
//     server-side, never trusted from client
//   - Signed URLs scoped to specific keys, expire in 1 hour
//
// Query params: ?folder=X&q=search-term
// Returns: { files: [{ id, name, size, type, folder, createdAt, url }] }

const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { s3, BUCKET } = require('../../lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const URL_EXPIRY_SECONDS = 3600; // 1 hour
const MAX_FILES_RETURNED = 500;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.role !== 'admin' && session.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager role required' });
  }

  const subaccountId = session.subaccount_id;
  const folder = req.query.folder || '';
  const q = (req.query.q || '').trim().toLowerCase();

  // Build Supabase query
  let url = SUPABASE_URL + '/rest/v1/media_files'
    + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
    + '&order=created_at.desc'
    + '&limit=' + MAX_FILES_RETURNED;

  if (folder) {
    url += '&folder=eq.' + encodeURIComponent(folder);
  }
  if (q) {
    url += '&file_name=ilike.*' + encodeURIComponent(q) + '*';
  }

  let rows;
  try {
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      const errText = await r.text();
      console.error('list: db query failed:', errText);
      return res.status(500).json({ error: 'Could not load files' });
    }
    rows = await r.json();
  } catch (e) {
    console.error('list: db query error:', e);
    return res.status(500).json({ error: 'Could not load files' });
  }

  // Generate presigned GET URLs in parallel
  const files = await Promise.all((rows || []).map(async function(row) {
    let signedUrl = null;
    try {
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: row.file_key });
      signedUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_EXPIRY_SECONDS });
    } catch (e) {
      console.warn('list: presign failed for', row.file_key, e.message);
    }
    return {
      id:        row.id,
      name:      row.file_name,
      size:      row.file_size,
      type:      row.file_type,
      folder:    row.folder,
      createdAt: row.created_at,
      url:       signedUrl
    };
  }));

  // Build folder list - distinct folders for this subaccount
  let folders = [];
  try {
    const fr = await fetch(
      SUPABASE_URL + '/rest/v1/media_files'
      + '?subaccount_id=eq.' + encodeURIComponent(subaccountId)
      + '&select=folder',
      { headers: sbHeaders() }
    );
    if (fr.ok) {
      const fRows = await fr.json();
      const set = {};
      (fRows || []).forEach(function(r) { if (r.folder) set[r.folder] = true; });
      folders = Object.keys(set).sort();
    }
  } catch (e) { /* non-fatal */ }
  if (folders.indexOf('Uncategorized') < 0) folders.unshift('Uncategorized');

  return res.status(200).json({
    files:   files,
    folders: folders
  });
};
