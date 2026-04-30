// lib/s3-client.js
// Shared S3 client used by all media endpoints.
//
// CRITICAL: requestChecksumCalculation: 'WHEN_REQUIRED' is needed to prevent
// AWS SDK v3 from injecting checksum headers into presigned URLs. Without this
// setting, browser uploads via presigned URLs fail with "SignatureDoesNotMatch"
// errors because the SDK adds x-amz-checksum-* headers that are NOT part of
// the signature, but the browser includes them in the request, breaking signature
// verification.
//
// Reference: https://github.com/aws/aws-sdk-js-v3/issues/6810

const { S3Client } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'us-east-2';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  // ⚠ REQUIRED: prevents AWS SDK v3 from breaking presigned URLs
  requestChecksumCalculation: 'WHEN_REQUIRED'
});

const BUCKET = process.env.S3_BUCKET;
const KMS_KEY_ARN = process.env.KMS_KEY_ARN;

module.exports = {
  s3,
  BUCKET,
  KMS_KEY_ARN,
  REGION
};
