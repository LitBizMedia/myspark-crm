#!/bin/bash
#
# setup-cloudfront.sh
#
# Phase 11: Move static HTML hosting from Vercel to S3 + CloudFront.
#
# Steps (Pass 1):
#   1. Create S3 bucket (private)
#   2. Upload index.html
#   3. Request ACM cert in us-east-1 (CloudFront requirement)
#   4. Output validation CNAME for Namecheap
#   5. Halt for cert validation
#
# Steps (Pass 2 - re-run after validation):
#   6. Create CloudFront distribution
#   7. Add custom domain mapping
#   8. Output final CNAME for Namecheap

set -e

REGION_S3="us-east-2"
REGION_ACM="us-east-1"
DOMAIN_PRIMARY="mysparkplus.app"
DOMAIN_WWW="www.mysparkplus.app"
BUCKET_NAME="myspark-app-www"

if ! command -v aws &> /dev/null; then
  echo "ERROR: aws CLI not found." >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "ERROR: jq not found." >&2
  exit 1
fi

echo "================================================================"
echo "Setting up S3 + CloudFront for $DOMAIN_PRIMARY"
echo "================================================================"

# ========================================
# Step 1: S3 bucket
# ========================================
echo ""
echo "Step 1: S3 bucket"

if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION_S3" 2>/dev/null; then
  echo "  Bucket already exists: $BUCKET_NAME"
else
  echo "  Creating bucket: $BUCKET_NAME"
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION_S3" \
    --create-bucket-configuration LocationConstraint="$REGION_S3" \
    >/dev/null
  
  # Block all public access (CloudFront will use OAC)
  aws s3api put-public-access-block \
    --bucket "$BUCKET_NAME" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    >/dev/null
  
  # Enable versioning (cheap insurance)
  aws s3api put-bucket-versioning \
    --bucket "$BUCKET_NAME" \
    --versioning-configuration Status=Enabled \
    >/dev/null
  
  echo "  Bucket created with public access blocked + versioning enabled"
fi

# ========================================
# Step 2: Upload index.html
# ========================================
echo ""
echo "Step 2: Upload index.html"

if [ ! -f "index.html" ]; then
  echo "  ERROR: index.html not found in current directory"
  exit 1
fi

aws s3 cp index.html "s3://$BUCKET_NAME/index.html" \
  --region "$REGION_S3" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=300" \
  >/dev/null
echo "  Uploaded index.html ($(du -h index.html | cut -f1))"

# Also upload the favicon/logo if present
if [ -f "MySpark+.png" ]; then
  aws s3 cp "MySpark+.png" "s3://$BUCKET_NAME/MySpark+.png" \
    --region "$REGION_S3" \
    --content-type "image/png" \
    --cache-control "public, max-age=86400" \
    >/dev/null
  echo "  Uploaded MySpark+.png"
fi

# ========================================
# Step 3: ACM certificate (in us-east-1!)
# ========================================
echo ""
echo "Step 3: ACM certificate (us-east-1 for CloudFront)"

CERT_ARN=$(aws acm list-certificates \
  --region "$REGION_ACM" \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN_PRIMARY'].CertificateArn | [0]" \
  --output text)

if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  echo "  Requesting new certificate for $DOMAIN_PRIMARY + $DOMAIN_WWW"
  CERT_ARN=$(aws acm request-certificate \
    --domain-name "$DOMAIN_PRIMARY" \
    --subject-alternative-names "$DOMAIN_WWW" \
    --validation-method DNS \
    --region "$REGION_ACM" \
    --query 'CertificateArn' \
    --output text)
  echo "  Cert ARN: $CERT_ARN"
  echo "  Waiting 10s for validation records to populate..."
  sleep 10
else
  echo "  Existing cert found: $CERT_ARN"
fi

CERT_DETAILS=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --region "$REGION_ACM" \
  --output json)

CERT_STATUS=$(echo "$CERT_DETAILS" | jq -r '.Certificate.Status')

# ========================================
# Step 4: Output validation records or proceed
# ========================================

if [ "$CERT_STATUS" = "PENDING_VALIDATION" ]; then
  echo ""
  echo "  ⚠️  CERTIFICATE NOT YET VALIDATED"
  echo ""
  echo "  Add these CNAME records to Namecheap:"
  echo ""
  
  echo "$CERT_DETAILS" | jq -r '.Certificate.DomainValidationOptions[] | 
    "  For " + .DomainName + ":\n    Host: " + (.ResourceRecord.Name | rtrimstr(".'$DOMAIN_PRIMARY'.")) + "\n    Type: CNAME\n    Value: " + .ResourceRecord.Value + "\n"'
  
  echo ""
  echo "  After adding, wait 5-30 min for AWS to validate, then re-run this script."
  echo ""
  echo "================================================================"
  echo "Halted at validation step."
  echo "================================================================"
  exit 0
fi

if [ "$CERT_STATUS" != "ISSUED" ]; then
  echo "  ❌ Certificate status: $CERT_STATUS - cannot proceed"
  exit 1
fi

echo "  ✅ Certificate validated and issued"

# ========================================
# Step 5: Origin Access Control (modern way to lock S3 to CloudFront only)
# ========================================
echo ""
echo "Step 5: Origin Access Control"

OAC_NAME="myspark-app-oac"
OAC_ID=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" \
  --output text 2>/dev/null)

if [ -z "$OAC_ID" ] || [ "$OAC_ID" = "None" ]; then
  echo "  Creating OAC..."
  OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "Name=$OAC_NAME,Description=Lock S3 to CloudFront only,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query 'OriginAccessControl.Id' \
    --output text)
  echo "  OAC ID: $OAC_ID"
else
  echo "  Existing OAC found: $OAC_ID"
fi

# ========================================
# Step 6: CloudFront distribution
# ========================================
echo ""
echo "Step 6: CloudFront distribution"

DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items[?@=='$DOMAIN_PRIMARY']].Id | [0]" \
  --output text 2>/dev/null)

if [ -z "$DIST_ID" ] || [ "$DIST_ID" = "None" ]; then
  echo "  Creating CloudFront distribution..."
  
  CALLER_REF="myspark-app-$(date +%s)"
  S3_DOMAIN="$BUCKET_NAME.s3.$REGION_S3.amazonaws.com"
  
  CONFIG=$(cat <<JSON
{
  "CallerReference": "$CALLER_REF",
  "Aliases": {
    "Quantity": 2,
    "Items": ["$DOMAIN_PRIMARY", "$DOMAIN_WWW"]
  },
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-$BUCKET_NAME",
      "DomainName": "$S3_DOMAIN",
      "OriginAccessControlId": "$OAC_ID",
      "S3OriginConfig": {"OriginAccessIdentity": ""}
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-$BUCKET_NAME",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}
    },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6"
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [{
      "ErrorCode": 403,
      "ResponseCode": "200",
      "ResponsePagePath": "/index.html",
      "ErrorCachingMinTTL": 0
    }]
  },
  "Comment": "MySpark+ static hosting",
  "Enabled": true,
  "ViewerCertificate": {
    "ACMCertificateArn": "$CERT_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2"
}
JSON
)
  
  TMP=$(mktemp)
  echo "$CONFIG" > "$TMP"
  
  DIST_RESULT=$(aws cloudfront create-distribution \
    --distribution-config "file://$TMP" \
    --output json)
  
  DIST_ID=$(echo "$DIST_RESULT" | jq -r '.Distribution.Id')
  DIST_DOMAIN=$(echo "$DIST_RESULT" | jq -r '.Distribution.DomainName')
  
  rm "$TMP"
  
  echo "  Distribution ID: $DIST_ID"
  echo "  CloudFront domain: $DIST_DOMAIN"
  echo "  Status: deploying (takes ~5-10 min)"
else
  echo "  Existing distribution: $DIST_ID"
  DIST_DOMAIN=$(aws cloudfront get-distribution \
    --id "$DIST_ID" \
    --query 'Distribution.DomainName' \
    --output text)
fi

# ========================================
# Step 7: S3 bucket policy allowing CloudFront via OAC
# ========================================
echo ""
echo "Step 7: S3 bucket policy"

POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET_NAME/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::$(aws sts get-caller-identity --query Account --output text):distribution/$DIST_ID"
      }
    }
  }]
}
JSON
)

TMP=$(mktemp)
echo "$POLICY" > "$TMP"
aws s3api put-bucket-policy \
  --bucket "$BUCKET_NAME" \
  --policy "file://$TMP" \
  --region "$REGION_S3"
rm "$TMP"
echo "  Bucket policy applied"

# ========================================
# Step 8: Output final DNS instructions
# ========================================
echo ""
echo "================================================================"
echo "CloudFront setup complete"
echo "================================================================"
echo ""
echo "  Bucket:           $BUCKET_NAME"
echo "  CloudFront ID:    $DIST_ID"
echo "  CloudFront URL:   https://$DIST_DOMAIN"
echo ""
echo "================================================================"
echo "FINAL DNS STEP - Update Namecheap:"
echo "================================================================"
echo ""
echo "  ⚠️  DO THIS LAST. Once DNS changes, traffic moves to CloudFront."
echo ""
echo "  In Namecheap, REMOVE the existing A and CNAME records for:"
echo "    @ (apex)  - currently points to Vercel"
echo "    www       - currently points to Vercel"
echo ""
echo "  ADD new records:"
echo ""
echo "    Type:  CNAME (or ALIAS if your DNS supports it)"
echo "    Host:  @"
echo "    Value: $DIST_DOMAIN"
echo "    TTL:   Automatic"
echo ""
echo "    Type:  CNAME"
echo "    Host:  www"
echo "    Value: $DIST_DOMAIN"
echo "    TTL:   Automatic"
echo ""
echo "  Note: Namecheap may not allow CNAME on apex (@). If so, use ALIAS"
echo "        record type instead. If neither works, use Namecheap's"
echo "        URL forwarding to redirect www → apex, then point apex to"
echo "        CloudFront via the underlying IP. We'll handle this if needed."
echo ""
echo "  Test BEFORE DNS update:"
echo "    curl -H 'Host: $DOMAIN_PRIMARY' https://$DIST_DOMAIN/"
echo ""
echo "  Test AFTER DNS update (5-30 min later):"
echo "    curl https://$DOMAIN_PRIMARY/ | head -20"
echo ""
echo "================================================================"
