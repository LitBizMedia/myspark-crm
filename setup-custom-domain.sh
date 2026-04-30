#!/bin/bash
#
# setup-custom-domain.sh
#
# Sets up api.mysparkplus.app for the API Gateway.
# 
# Steps:
#   1. Request ACM certificate (with DNS validation)
#   2. Output validation DNS records (you add to registrar)
#   3. Wait for validation
#   4. Create API Gateway custom domain
#   5. Map domain to API
#   6. Output target CNAME (you add to registrar)
#
# Re-run safe: detects existing resources.

set -e

REGION="us-east-2"
DOMAIN="api.mysparkplus.app"
API_NAME="myspark-api"
STAGE_NAME="prod"

if ! command -v aws &> /dev/null; then
  echo "ERROR: aws CLI not found." >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "ERROR: jq not found. Install with: brew install jq" >&2
  exit 1
fi

echo "================================================================"
echo "Setting up custom domain: $DOMAIN"
echo "================================================================"

# ========================================
# Step 1: Find or request ACM certificate
# ========================================
echo ""
echo "Step 1: SSL certificate (ACM)"

# Look for an existing cert for this domain
CERT_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" \
  --output text)

if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  echo "  No existing cert. Requesting new certificate..."
  CERT_ARN=$(aws acm request-certificate \
    --domain-name "$DOMAIN" \
    --validation-method DNS \
    --region "$REGION" \
    --query 'CertificateArn' \
    --output text)
  echo "  Certificate requested: $CERT_ARN"
  echo "  Waiting 10 seconds for cert details to populate..."
  sleep 10
else
  echo "  Found existing cert: $CERT_ARN"
fi

# ========================================
# Step 2: Get validation records
# ========================================
echo ""
echo "Step 2: Certificate validation"

CERT_DETAILS=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --region "$REGION" \
  --output json)

CERT_STATUS=$(echo "$CERT_DETAILS" | jq -r '.Certificate.Status')
echo "  Status: $CERT_STATUS"

VALIDATION_NAME=$(echo "$CERT_DETAILS" | jq -r '.Certificate.DomainValidationOptions[0].ResourceRecord.Name // empty')
VALIDATION_VALUE=$(echo "$CERT_DETAILS" | jq -r '.Certificate.DomainValidationOptions[0].ResourceRecord.Value // empty')

if [ "$CERT_STATUS" = "PENDING_VALIDATION" ]; then
  echo ""
  echo "  ⚠️  CERTIFICATE NOT YET VALIDATED"
  echo ""
  echo "  ACTION REQUIRED: Add this CNAME record to your DNS:"
  echo ""
  echo "    Name:  $VALIDATION_NAME"
  echo "    Type:  CNAME"
  echo "    Value: $VALIDATION_VALUE"
  echo ""
  echo "  After adding, wait 5-30 minutes for AWS to detect, then re-run this script."
  echo ""
  echo "================================================================"
  echo "Halting at validation step. Add DNS record then re-run."
  echo "================================================================"
  exit 0
fi

if [ "$CERT_STATUS" != "ISSUED" ]; then
  echo "  ❌ Certificate status is $CERT_STATUS - cannot proceed"
  exit 1
fi

echo "  ✅ Certificate validated and issued"

# ========================================
# Step 3: Create custom domain in API Gateway
# ========================================
echo ""
echo "Step 3: API Gateway custom domain"

EXISTING_DOMAIN=$(aws apigatewayv2 get-domain-name \
  --domain-name "$DOMAIN" \
  --region "$REGION" \
  --query 'DomainName' \
  --output text 2>/dev/null) || EXISTING_DOMAIN=""

if [ -z "$EXISTING_DOMAIN" ]; then
  echo "  Creating custom domain..."
  aws apigatewayv2 create-domain-name \
    --domain-name "$DOMAIN" \
    --domain-name-configurations "CertificateArn=$CERT_ARN,EndpointType=REGIONAL,SecurityPolicy=TLS_1_2" \
    --region "$REGION" \
    >/dev/null
  echo "  Created"
else
  echo "  Domain already exists in API Gateway"
fi

# Get the regional target (CNAME we'll need for DNS)
DOMAIN_DETAILS=$(aws apigatewayv2 get-domain-name \
  --domain-name "$DOMAIN" \
  --region "$REGION" \
  --output json)

REGIONAL_TARGET=$(echo "$DOMAIN_DETAILS" | jq -r '.DomainNameConfigurations[0].ApiGatewayDomainName')

# ========================================
# Step 4: Map the domain to the API stage
# ========================================
echo ""
echo "Step 4: API mapping"

API_ID=$(aws apigatewayv2 get-apis \
  --region "$REGION" \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" \
  --output text)

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "  ❌ API '$API_NAME' not found - run setup-api-gateway.sh first"
  exit 1
fi

EXISTING_MAPPING=$(aws apigatewayv2 get-api-mappings \
  --domain-name "$DOMAIN" \
  --region "$REGION" \
  --query "Items[?ApiId=='$API_ID' && Stage=='$STAGE_NAME'].ApiMappingId | [0]" \
  --output text 2>/dev/null) || EXISTING_MAPPING=""

if [ -z "$EXISTING_MAPPING" ] || [ "$EXISTING_MAPPING" = "None" ]; then
  echo "  Creating API mapping..."
  aws apigatewayv2 create-api-mapping \
    --domain-name "$DOMAIN" \
    --api-id "$API_ID" \
    --stage "$STAGE_NAME" \
    --region "$REGION" \
    >/dev/null
  echo "  Created"
else
  echo "  Mapping already exists"
fi

# ========================================
# Final output
# ========================================
echo ""
echo "================================================================"
echo "Custom domain setup complete"
echo "================================================================"
echo ""
echo "  Domain:           $DOMAIN"
echo "  Certificate:      $CERT_ARN"
echo "  API:              $API_NAME ($API_ID)"
echo "  Stage:            $STAGE_NAME"
echo ""
echo "================================================================"
echo "FINAL DNS STEP - Add this CNAME to point users at the API:"
echo "================================================================"
echo ""
echo "  Type:  CNAME"
echo "  Host:  api"
echo "  Value: $REGIONAL_TARGET"
echo "  TTL:   300 (or 'automatic')"
echo ""
echo "After adding (and ~5 min DNS propagation), test with:"
echo ""
echo "  curl https://$DOMAIN/api/square/config"
echo ""
echo "Should return: {\"appId\":\"sq0idp-...\",\"env\":\"production\"}"
echo ""
echo "================================================================"
