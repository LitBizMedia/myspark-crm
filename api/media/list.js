import { requireSubaccountAuth } from '../../lib/require-subaccount-auth.js';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { subaccountId } = auth;
  const { folder, search, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('media_files')
      .select('*', { count: 'exact' })
      .eq('subaccount_id', subaccountId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (folder && folder !== 'all') {
      query = query.eq('folder', folder);
    }

    if (search) {
      query = query.ilike('file_name', `%${search}%`);
    }

    const { data: files, error, count } = await query;

    if (error) {
      console.error('media list error:', error);
      return res.status(500).json({ error: 'Failed to fetch media files' });
    }

    const filesWithUrls = await Promise.all(
      (files || []).map(async (file) => {
        try {
          const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: file.file_key
          });
          const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
          return { ...file, url };
        } catch {
          return { ...file, url: null };
        }
      })
    );

    return res.status(200).json({ files: filesWithUrls, total: count });

  } catch (err) {
    console.error('list error:', err);
    return res.status(500).json({ error: 'Failed to fetch media files' });
  }
}
