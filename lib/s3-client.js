// lib/s3-client.js
// Shared S3 client for media endpoints.
// requestChecksumCalculation: WHEN_REQUIRED prevents SDK v3 from automatically
// injecting x-amz-checksum-sha256 into presigned URLs, which causes
// SignatureDoesNotMatch errors when the browser fetches them.

const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});

module.exports = { s3 };
