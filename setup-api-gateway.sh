#!/bin/bash
#
# setup-api-gateway.sh
#
# Creates an HTTP API Gateway and wires up all 47 Lambda functions.
# Idempotent: safe to re-run, will skip resources that already exist.

set -e

REGION="us-east-2"
ACCOUNT_ID="993939946677"
API_NAME="myspark-api"
STAGE_NAME="prod"

# CORS allowed origins - same set as Lambda env vars
CORS_ALLOWED_ORIGINS="https://mysparkplus.app,https://www.mysparkplus.app,https://aws.mysparkplus.app"

if ! command -v aws &> /dev/null; then
  echo "ERROR: aws CLI not found." >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "ERROR: jq not found. Install with: brew install jq" >&2
  exit 1
fi

echo "================================================================"
echo "Setting up API Gateway: $API_NAME"
echo "================================================================"

# ========================================
# Step 1: Find or create the HTTP API
# ========================================
echo ""
echo "Step 1: HTTP API"

API_ID=$(aws apigatewayv2 get-apis \
  --region "$REGION" \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" \
  --output text)

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "  Creating new HTTP API..."
  API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --description "MySpark+ CRM API gateway" \
    --cors-configuration "AllowOrigins=$CORS_ALLOWED_ORIGINS,AllowMethods=GET,POST,PUT,PATCH,DELETE,OPTIONS,AllowHeaders=Content-Type,Authorization,X-Requested-With,Cookie,AllowCredentials=true,MaxAge=600" \
    --region "$REGION" \
    --query 'ApiId' \
    --output text)
  echo "  Created API: $API_ID"
else
  echo "  Using existing API: $API_ID"
fi

API_ENDPOINT=$(aws apigatewayv2 get-api \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query 'ApiEndpoint' \
  --output text)

echo "  Endpoint: $API_ENDPOINT"

# ========================================
# Step 2: Build list of Lambda → route mappings
# ========================================
echo ""
echo "Step 2: Discovering Lambdas..."

LAMBDAS=$(aws lambda list-functions \
  --region "$REGION" \
  --query 'Functions[?starts_with(FunctionName, `myspark-api-`)].FunctionName' \
  --output text | tr '\t' '\n' | sort)

LAMBDA_COUNT=$(echo "$LAMBDAS" | wc -l | tr -d ' ')
echo "  Found $LAMBDA_COUNT Lambdas"

# ========================================
# Step 3: For each Lambda, create integration + route + permission
# ========================================
echo ""
echo "Step 3: Wiring up routes..."
echo ""

# Get existing routes to avoid duplicates
EXISTING_ROUTES=$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query 'Items[].RouteKey' \
  --output text | tr '\t' '\n')

# Get existing integrations to avoid duplicates
EXISTING_INTEGRATIONS_JSON=$(aws apigatewayv2 get-integrations \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query 'Items[].[IntegrationId,IntegrationUri]' \
  --output json)

COUNT=0
CREATED_INTEG=0
CREATED_ROUTE=0
SKIPPED_INTEG=0
SKIPPED_ROUTE=0
FAILED=0

for LAMBDA_NAME in $LAMBDAS; do
  COUNT=$((COUNT + 1))
  
  # Convert Lambda name to API path
  # myspark-api-agency-audit-log     → /api/agency/audit-log
  # myspark-api-email-domains-add    → /api/email/domains/add
  # myspark-api-square-config        → /api/square/config
  PATH_PART="${LAMBDA_NAME#myspark-api-}"
  
  # Known nested paths - email/domains and any other 2-level paths
  case "$PATH_PART" in
    email-domains-*)
      ROUTE_PATH="/api/email/domains/${PATH_PART#email-domains-}"
      ;;
    *)
      # Default: replace first hyphen with slash
      # (agency-audit-log → agency/audit-log, billing-list-cards → billing/list-cards)
      FIRST_PART="${PATH_PART%%-*}"
      REST="${PATH_PART#*-}"
      ROUTE_PATH="/api/$FIRST_PART/$REST"
      ;;
  esac
  
  ROUTE_KEY="ANY $ROUTE_PATH"
  LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$LAMBDA_NAME"
  INTEGRATION_URI="arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$LAMBDA_ARN/invocations"
  
  printf "[%2d/%d] %-50s → %-40s ... " "$COUNT" "$LAMBDA_COUNT" "$LAMBDA_NAME" "$ROUTE_PATH"
  
  # Check if integration already exists for this Lambda
  EXISTING_INTEG_ID=$(echo "$EXISTING_INTEGRATIONS_JSON" | jq -r --arg uri "$INTEGRATION_URI" '.[] | select(.[1] == $uri) | .[0]' | head -1)
  
  if [ -n "$EXISTING_INTEG_ID" ] && [ "$EXISTING_INTEG_ID" != "null" ]; then
    INTEG_ID="$EXISTING_INTEG_ID"
    SKIPPED_INTEG=$((SKIPPED_INTEG + 1))
    INTEG_STATUS="reused"
  else
    # Create integration
    INTEG_ID=$(aws apigatewayv2 create-integration \
      --api-id "$API_ID" \
      --integration-type AWS_PROXY \
      --integration-uri "$LAMBDA_ARN" \
      --payload-format-version "2.0" \
      --timeout-in-millis 30000 \
      --region "$REGION" \
      --query 'IntegrationId' \
      --output text 2>/dev/null) || {
      echo "INTEG FAILED"
      FAILED=$((FAILED + 1))
      continue
    }
    CREATED_INTEG=$((CREATED_INTEG + 1))
    INTEG_STATUS="new"
  fi
  
  # Check if route already exists
  if echo "$EXISTING_ROUTES" | grep -qF "$ROUTE_KEY"; then
    SKIPPED_ROUTE=$((SKIPPED_ROUTE + 1))
    echo "integ:$INTEG_STATUS route:exists"
  else
    # Create route
    aws apigatewayv2 create-route \
      --api-id "$API_ID" \
      --route-key "$ROUTE_KEY" \
      --target "integrations/$INTEG_ID" \
      --region "$REGION" \
      >/dev/null 2>&1 || {
      echo "ROUTE FAILED"
      FAILED=$((FAILED + 1))
      continue
    }
    CREATED_ROUTE=$((CREATED_ROUTE + 1))
    echo "integ:$INTEG_STATUS route:created"
  fi
  
  # Add Lambda permission to allow API Gateway to invoke
  # (idempotent: ignore "already exists" errors)
  STATEMENT_ID="apigw-${API_ID}"
  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "$STATEMENT_ID" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*" \
    --region "$REGION" \
    >/dev/null 2>&1 || true
  
  # Brief pause to avoid throttling
  sleep 0.1
done

# ========================================
# Step 4: Create or update prod stage
# ========================================
echo ""
echo "Step 4: Stage configuration..."

STAGE_EXISTS=$(aws apigatewayv2 get-stages \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query "Items[?StageName=='$STAGE_NAME'].StageName | [0]" \
  --output text)

if [ -z "$STAGE_EXISTS" ] || [ "$STAGE_EXISTS" = "None" ]; then
  aws apigatewayv2 create-stage \
    --api-id "$API_ID" \
    --stage-name "$STAGE_NAME" \
    --auto-deploy \
    --region "$REGION" \
    >/dev/null
  echo "  Created stage: $STAGE_NAME (auto-deploy enabled)"
else
  echo "  Stage already exists: $STAGE_NAME"
fi

# ========================================
# Step 5: Summary
# ========================================
echo ""
echo "================================================================"
echo "API Gateway setup complete"
echo "================================================================"
echo "  Total Lambdas:           $COUNT"
echo "  Integrations created:    $CREATED_INTEG"
echo "  Integrations reused:     $SKIPPED_INTEG"
echo "  Routes created:          $CREATED_ROUTE"
echo "  Routes already existed:  $SKIPPED_ROUTE"
echo "  Failed:                  $FAILED"
echo ""
echo "  API ID:        $API_ID"
echo "  Base URL:      $API_ENDPOINT/$STAGE_NAME"
echo ""
echo "  Test with:"
echo "    curl $API_ENDPOINT/$STAGE_NAME/api/square/config"
echo ""
echo "================================================================"
