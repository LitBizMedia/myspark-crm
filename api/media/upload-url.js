// api/media/upload-url.js
// Generates a presigned S3 PUT URL for direct browser-to-S3 upload.
// Saves the file metadata to the media_files table.
//
// Security:
//   - Auth: subaccount session required, role admin or manager
//   - Subaccount slug isolation: cookie-derived, not trusted from body
//   - File type allowlist enforced server-side
//   - File size cap enforced server-side
//   - S3 key prefixed with the subaccount slug, so even if RLS broke,
//     the IAM policy + key prefix prevents cross-tenant access
//   - URL expires in 5 minutes (uploads must be quick)
//
// Body: { fileName, fileType, fileSize, folder? }
// Returns: { uploadUrl, fileId, fileKey }

const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const { s3, BUCKET, KMS_KEY_ARN } = require('../../lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const URL_EXPIRY_SECONDS = 300; // 5 minutes

const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv'
];

const ALLOWED_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'
];

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

function getExtension(fileName) {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

// Sanitize folder name - alphanumeric, spaces, hyphens, underscores only
function sanitizeFolder(folder) {
  if (!folder) return 'Uncategorized';
  const cleaned = String(folder).trim().replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 64);
  return cleaned || 'Uncategorized';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
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

  // Slug from session - never trust the body for this
  const subaccountId = session.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');

  const { fileName, fileType, fileSize, folder } = req.body || {};

  // Validation
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName required' });
  }
  if (!fileType || typeof fileType !== 'string') {
    return res.status(400).json({ error: 'fileType required' });
  }
  if (typeof fileSize !== 'number' || fileSize <= 0) {
    return res.status(400).json({ error: 'fileSize required and must be positive' });
  }
  if (fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: 'File too large. Maximum 50MB.' });
  }

  // Type allowlist - check both MIME and extension
  const ext = getExtension(fileName);
  if (ALLOWED_EXTENSIONS.indexOf(ext) < 0) {
    return res.status(400).json({ error: 'File type not allowed: .' + ext });
  }
  if (ALLOWED_MIME_TYPES.indexOf(fileType.toLowerCase()) < 0) {
    return res.status(400).json({ error: 'MIME type not allowed: ' + fileType });
  }

  // File name sanitization - the original name is stored as display, but the
  // S3 key uses a UUID. This avoids issues with special chars / collisions.
  const safeName = String(fileName).slice(0, 255);
  const safeFolder = sanitizeFolder(folder);

  // Build S3 key. Slug prefix is critical for IAM-level isolation.
  const fileId = crypto.randomUUID();
  const fileKey = slug + '/' + safeFolder.replace(/\s+/g, '-').toLowerCase() + '/' + fileId + '.' + ext;

  // Generate presigned PUT URL
  let uploadUrl;
  try {
    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: fileKey,
      ContentType: fileType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN
    });
    uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_EXPIRY_SECONDS });
  } catch (e) {
    console.error('upload-url: presign failed:', e);
    return res.status(500).json({ error: 'Could not generate upload URL' });
  }

  // Save metadata to Supabase. Note: we save BEFORE the upload completes.
  // If the upload fails or is abandoned, we'll have orphan rows. A periodic
  // cleanup job could verify S3 existence, but for now this is acceptable.
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/media_files', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        id:            fileId,
        subaccount_id: subaccountId,
        uploaded_by:   session.user_id,
        file_name:     safeName,
        file_key:      fileKey,
        file_size:     fileSize,
        file_type:     fileType,
        folder:        safeFolder
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('upload-url: metadata save failed:', errText);
      return res.status(500).json({ error: 'Could not save file metadata' });
    }
  } catch (e) {
    console.error('upload-url: metadata save error:', e);
    return res.status(500).json({ error: 'Could not save file metadata' });
  }

  // Audit
  await logAudit({
    req,
    actorType:    'subaccount',
    actorId:       session.user_id,
    actorUsername: session.username,
    actorRole:     session.role,
    action: 'subaccount.media.upload',
    targetType: 'media_file',
    targetId: fileId,
    targetSubaccountId: subaccountId,
    metadata: {
      file_name: safeName,
      file_size: fileSize,
      file_type: fileType,
      folder:    safeFolder
    }
  });

  return res.status(200).json({
    uploadUrl: uploadUrl,
    fileId:    fileId,
    fileKey:   fileKey
  });
};
