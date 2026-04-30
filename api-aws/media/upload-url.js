// api/media/upload-url.js (Lambda version)
//
// POST /api/media/upload-url
//
// Generates a presigned S3 PUT URL for direct browser upload.
// Saves file metadata to media_files table.
// Admin or manager role required.
//
// MIGRATED: Supabase REST → lib/db.js for metadata insert.

const db = require('./lib/db');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const { s3, BUCKET } = require('./lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const URL_EXPIRY_SECONDS = 300; // 5 minutes

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
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

function getExtension(fileName) {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

function sanitizeFolder(folder) {
  if (!folder) return 'Uncategorized';
  const cleaned = String(folder).trim().replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 64);
  return cleaned || 'Uncategorized';
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = parseSessionCookie(req);
  const session = await validateSession(token);
  if (!session || session.user_type !== 'subaccount') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (session.role !== 'admin' && session.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager role required' });
  }

  const subaccountId = session.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');

  const { fileName, fileType, fileSize, folder } = req.body || {};

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

  const ext = getExtension(fileName);
  if (ALLOWED_EXTENSIONS.indexOf(ext) < 0) {
    return res.status(400).json({ error: 'File type not allowed: .' + ext });
  }
  if (ALLOWED_MIME_TYPES.indexOf(fileType.toLowerCase()) < 0) {
    return res.status(400).json({ error: 'MIME type not allowed: ' + fileType });
  }

  const safeName = String(fileName).slice(0, 255);
  const safeFolder = sanitizeFolder(folder);

  const fileId = crypto.randomUUID();
  const fileKey = slug + '/' + safeFolder.replace(/\s+/g, '-').toLowerCase() + '/' + fileId + '.' + ext;

  // Generate presigned PUT URL
  let uploadUrl;
  try {
    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: fileKey,
      ContentType: fileType
    });
    uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_EXPIRY_SECONDS });
  } catch (e) {
    console.error('upload-url: presign failed:', e);
    return res.status(500).json({ error: 'Could not generate upload URL' });
  }

  // Save metadata
  try {
    await db.insertOne('media_files', {
      id:            fileId,
      subaccount_id: subaccountId,
      uploaded_by:   session.user_id,
      file_name:     safeName,
      file_key:      fileKey,
      file_size:     fileSize,
      file_type:     fileType,
      folder:        safeFolder
    });
  } catch (e) {
    console.error('upload-url: metadata save error:', e);
    return res.status(500).json({ error: 'Could not save file metadata' });
  }

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
}

exports.handler = wrap(handler);
