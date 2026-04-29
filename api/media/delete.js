// api/media/delete.js
// Deletes a media file from S3 and removes its metadata row from Supabase.
//
// Security:
//   - Auth: subaccount session required, admin or manager role
//   - Slug isolation: file's subaccount_id must match session.subaccount_id
//   - Audited
//
// Body: { fileId }
// Returns: { success: true }

const { DeleteObjectCommand } = require('@aws-sdk/client-s3');

const { s3, BUCKET } = require('../../lib/s3-client');
const {
  parseSessionCookie,
  validateSession
} = require('../../lib/subaccount-auth');
const { logAudit } = require('../../lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
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
  const { fileId } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'fileId required' });

  // Look up the file metadata, scoped to this subaccount
  let fileRow;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/media_files'
      + '?id=eq.' + encodeURIComponent(fileId)
      + '&subaccount_id=eq.' + encodeURIComponent(subaccountId)
      + '&select=*',
      { headers: sbHeaders() }
    );
    if (!r.ok) return res.status(500).json({ error: 'Lookup failed' });
    const rows = await r.json();
    if (!rows || !rows.length) {
      // Either doesn't exist or belongs to a different subaccount.
      // Same response either way - don't leak existence info.
      return res.status(404).json({ error: 'File not found' });
    }
    fileRow = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Lookup failed: ' + e.message });
  }

  // Delete from S3 first. If S3 fails (already deleted, missing, etc), we
  // still proceed to delete the metadata row - orphans on S3 are less
  // problematic than orphans in the metadata table.
  let s3Deleted = false;
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key:    fileRow.file_key
    }));
    s3Deleted = true;
  } catch (e) {
    // NoSuchKey is fine - file already gone from S3
    if (e.name !== 'NoSuchKey' && e.Code !== 'NoSuchKey') {
      console.warn('delete: S3 delete had error:', e.message);
    } else {
      s3Deleted = true; // count it as success since the file is gone
    }
  }

  // Delete the metadata row
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/media_files'
      + '?id=eq.' + encodeURIComponent(fileId)
      + '&subaccount_id=eq.' + encodeURIComponent(subaccountId),
      { method: 'DELETE', headers: sbHeaders({ 'Prefer': 'return=minimal' }) }
    );
    if (!r.ok) {
      const errText = await r.text();
      console.error('delete: metadata delete failed:', errText);
      return res.status(500).json({ error: 'Could not remove file metadata' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Metadata delete error: ' + e.message });
  }

  // Audit
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
};
