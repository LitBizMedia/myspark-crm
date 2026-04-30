// api/media/list.js (Lambda version)
//
// GET /api/media/list
//
// Lists media files for current subaccount with presigned GET URLs.
// Open to any authenticated subaccount user (not just admin/manager).
//
// MIGRATED: Supabase REST → lib/db.js for media_files queries.

const db = require('./lib/db');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, BUCKET } = require('./lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');

const URL_EXPIRY_SECONDS = 3600; // 1 hour
const MAX_FILES_RETURNED = 500;

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const subaccountId = session.subaccount_id;
  const folder = req.query.folder || '';
  const q = (req.query.q || '').trim().toLowerCase();

  // Build query
  let rows;
  try {
    const whereParts = ['subaccount_id = $1'];
    const params = [subaccountId];
    let p = 2;

    if (folder) {
      whereParts.push('folder = $' + p++);
      params.push(folder);
    }
    if (q) {
      whereParts.push('file_name ILIKE $' + p++);
      params.push('%' + q + '%');
    }

    const result = await db.query(
      `SELECT * FROM media_files
       WHERE ${whereParts.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${MAX_FILES_RETURNED}`,
      params
    );
    rows = result.rows;
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
    const fr = await db.query(
      `SELECT DISTINCT folder FROM media_files
       WHERE subaccount_id = $1 AND folder IS NOT NULL
       ORDER BY folder`,
      [subaccountId]
    );
    folders = fr.rows.map(r => r.folder);
  } catch (e) { /* non-fatal */ }
  if (folders.indexOf('Uncategorized') < 0) folders.unshift('Uncategorized');

  return res.status(200).json({
    files:   files,
    folders: folders
  });
}

exports.handler = wrap(handler);
