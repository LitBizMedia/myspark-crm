import { requireSubaccountAuth } from '../../lib/require-subaccount-auth.js';
import { logAudit } from '../../lib/audit.js';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { subaccountId, subaccountSlug, userId } = auth;
  const { fileName, fileType, fileSize, folder = 'root' } = req.body;

  if (!fileName || !fileType || !fileSize) {
    return res.status(400).json({ error: 'fileName, fileType, and fileSize are required' });
  }

  if (!ALLOWED_TYPES.includes(fileType)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }

  if (fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: 'File exceeds 50MB limit' });
  }

  const ext = fileName.split('.').pop().toLowerCase();
  const fileId = randomUUID();
  const safeFolder = folder.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'root';
  const fileKey = `${subaccountSlug}/${safeFolder}/${fileId}.${ext}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: fileKey,
      ContentType: fileType,
      ContentLength: fileSize,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: process.env.AWS_KMS_KEY_ARN
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    const { error: dbError } = await supabase.from('media_files').insert({
      id: fileId,
      subaccount_id: subaccountId,
      uploaded_by: userId,
      file_name: fileName,
      file_key: fileKey,
      file_size: fileSize,
      file_type: fileType,
      folder: safeFolder
    });

    if (dbError) {
      console.error('media_files insert error:', dbError);
      return res.status(500).json({ error: 'Failed to record file metadata' });
    }

    await logAudit({
      subaccountId,
      userId,
      action: 'media.upload_initiated',
      resourceType: 'media_file',
      resourceId: fileId,
      detail: { fileName, fileType, fileSize, folder: safeFolder }
    });

    return res.status(200).json({ uploadUrl, fileKey, fileId });

  } catch (err) {
    console.error('upload-url error:', err);
    return res.status(500).json({ error: 'Failed to generate upload URL' });
  }
}
