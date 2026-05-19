// api-aws/subaccount/contracts-download.js
//
// Generates a fresh presigned URL for the signed PDF.
// Subaccount auth required. Used by the envelope detail drawer's
// "Download PDF" button.
//
// Route: GET /api/subaccount/contracts/download?id=env_xxx

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const contracts = require('./lib/contracts');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const CONTRACTS_BUCKET = 'myspark-contracts';
const s3Client = new S3Client({ region: 'us-east-2' });

async function handler(req, res){
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  if ((req.method || '').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = req.query || {};
  const id = q.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const subaccountId = auth.subaccount_id;
  const env = await contracts.getEnvelope(subaccountId, id);
  if (!env) return res.status(404).json({ error: 'Envelope not found' });
  if (env.status !== 'signed') {
    return res.status(400).json({ error: 'Envelope is not signed' });
  }
  if (!env.signedPdfS3Key) {
    return res.status(404).json({ error: 'PDF not available for this envelope' });
  }

  let url;
  try {
    url = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: CONTRACTS_BUCKET,
      Key: env.signedPdfS3Key
    }), { expiresIn: 5 * 60 });  // 5 min, just enough for the click
  } catch (e) {
    console.error('presigned URL generation failed:', e);
    return res.status(500).json({ error: 'Could not generate download link' });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract.download',
    targetType: 'contract_envelope',
    targetId: id,
    targetSubaccountId: subaccountId
  });

  return res.status(200).json({
    download_url: url,
    expires_in_seconds: 300
  });
}

exports.handler = wrap(handler);
