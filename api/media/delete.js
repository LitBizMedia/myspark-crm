import { requireSubaccountAuth } from '../../lib/require-subaccount-auth.js';
import { logAudit } from '../../lib/audit.js';
import { createClient } from '@supabase/supabase-js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { subaccountId, userId } = auth;
  const { fileId } = req.query;

  if (!fileId) {
    return res.status(400).json({ error: 'fileId is required' });
  }

  try {
    const { data: file, error: fetchError } = await supabase
      .from('media_files')
      .select('*')
      .eq('id', fileId)
      .eq('subaccount_id', subaccountId)
      .single();

    if (fetchError || !file) {
      return res.status(404).json({ error: 'File not found' });
    }

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: file.file_key
    }));

    const { error: deleteError } = await supabase
      .from('media_files')
      .delete()
      .eq('id', fileId)
      .eq('subaccount_id', subaccountId);

    if (deleteError) {
      console.error('media delete db error:', deleteError);
      return res.status(500).json({ error: 'Failed to remove file record' });
    }

    await logAudit({
      subaccountId,
      userId,
      action: 'media.deleted',
      resourceType: 'media_file',
      resourceId: fileId,
      detail: { fileName: file.file_name, fileKey: file.file_key }
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('delete error:', err);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
}
