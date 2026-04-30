// api/media/delete.js (Lambda version)
//
// POST/DELETE /api/media/delete
//
// Deletes a media file from S3 and removes its metadata row.
// Admin or manager role required. Audited.
//
// MIGRATED: Supabase REST → lib/db.js for media_files queries.

const db = require('./lib/db');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3, BUCKET } = require('./lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
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
  const { fileId } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'fileId required' });

  if (!UUID_REGEX.test(String(fileId))) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Look up file scoped to this subaccount
  let fileRow;
  try {
    fileRow = await db.findOne('media_files',
      { id: fileId, subaccount_id: subaccountId }
    );
  } catch (e) {
    return res.status(500).json({ error: 'Lookup failed: ' + e.message });
  }
  if (!fileRow) {
    // Either doesn't exist or wrong subaccount - same response prevents enumeration
    return res.status(404).json({ error: 'File not found' });
  }

  // Delete from S3 first
  let s3Deleted = false;
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key:    fileRow.file_key
    }));
    s3Deleted = true;
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.Code !== 'NoSuchKey') {
      console.warn('delete: S3 delete had error:', e.message);
    } else {
      s3Deleted = true;
    }
  }

  // Delete metadata row
  try {
    await db.deleteWhere('media_files',
      { id: fileId, subaccount_id: subaccountId }
    );
  } catch (e) {
    console.error('delete: metadata delete failed:', e.message);
    return res.status(500).json({ error: 'Could not remove file metadata' });
  }

  await logAudit({
    req,
    actorType:    'subaccount',
    actorId:       session.user_id,
    actorUsername: session.username,
    actorRole:     session.role,
    action: 'subaccount.media.delete',
    targetType: 'media_file',
    targetId: fileId,
    targetSubaccountId: subaccountId,
    metadata: {
      file_name: fileRow.file_name,
      file_key:  fileRow.file_key,
      folder:    fileRow.folder,
      s3_deleted: s3Deleted
    }
  });

  return res.status(200).json({ success: true });
}

exports.handler = wrap(handler);
