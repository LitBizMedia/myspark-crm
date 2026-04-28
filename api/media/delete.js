const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');
const { logAudit } = require('../../lib/audit');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await requireSubaccountAuth(req, res);
  if (!session) return;

  const subaccountId = session.subaccount_id;
  const userId = session.user_id;
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

    // Attempt S3 delete - don't fail if object is already missing
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: file.file_key
      }));
    } catch (s3Err) {
      console.warn('S3 delete warning (continuing):', s3Err.message);
    }

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
      req,
      actorType: session.user_type,
      actorId: userId,
      actorUsername: session.username,
      actorRole: session.role,
      action: 'media.deleted',
      targetSubaccountId: subaccountId,
      outcome: 'success',
      metadata: { fileId, fileName: file.file_name, fileKey: file.file_key }
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('delete error:', err);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
};
