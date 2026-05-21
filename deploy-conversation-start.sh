#!/usr/bin/env bash
# Deploy script for /api/subaccount/conversation-start
#
# Idempotent. Safe to re-run.
#   - If the Lambda exists, updates code only
#   - If the Lambda does not exist, creates it with full config
#   - If the API Gateway route exists, leaves it
#   - If not, creates integration + route + invoke permission
#
# Usage: bash deploy-conversation-start.sh

set -e

echo "🟢 START"

LAMBDA="myspark-api-subaccount-conversation-start"
SRC="api-aws/subaccount/conversation-start.js"
ROUTE_KEY="POST /api/subaccount/conversation-start"
API_ID="mcky8646b6"
REGION="us-east-2"
ACCOUNT="993939946677"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/myspark-lambda-execution-role"
VPC_SUBNETS="subnet-089d5b9a11be7b4c4,subnet-00d3f65fe32283e8f"
VPC_SG="sg-02cec0029eb95efd9"

# ─── 0. Sanity checks ───────────────────────────────────────────
echo "🟢 0. Sanity checks"
if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not found. Move conversation-start.js into api-aws/subaccount/ first."
  exit 1
fi

echo "🟢 1. Validate JS"
node --check "$SRC" && echo "OK"

echo ""
echo "🟢 2. Build deployment zip"
WORK=$(mktemp -d)
cp "$SRC" "$WORK/index.js"
mkdir -p "$WORK/lib"
cp lib-aws/*.js "$WORK/lib/"
cp -R .lambda-deps/node_modules "$WORK/node_modules"
echo '{"name":"x","main":"index.js"}' > "$WORK/package.json"
ZIP="$(pwd)/.lambda-builds/${LAMBDA}.zip"
mkdir -p .lambda-builds
rm -f "$ZIP"
cd "$WORK" && zip -r -q "$ZIP" . && cd - > /dev/null
rm -rf "$WORK"
echo "Built: $(du -h "$ZIP" | cut -f1)"

echo ""
echo "🟢 3. Check if Lambda exists"
if aws lambda get-function --function-name "$LAMBDA" --region "$REGION" >/dev/null 2>&1; then
  echo "Lambda exists, updating code only"
  aws lambda update-function-code \
    --function-name "$LAMBDA" \
    --zip-file "fileb://${ZIP}" \
    --region "$REGION" --no-cli-pager \
    --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated --function-name "$LAMBDA" --region "$REGION"
else
  echo "Lambda does not exist, creating fresh"

  cat > /tmp/env.json <<'EOF'
{
  "Variables": {
    "ALLOWED_ORIGINS": "https://mysparkplus.app,https://www.mysparkplus.app,https://aws.mysparkplus.app",
    "COOKIE_DOMAIN": ".mysparkplus.app",
    "RDS_DATABASE": "myspark",
    "RDS_PORT": "5432",
    "RDS_USER": "myspark_admin",
    "RDS_PROXY_HOST": "myspark-rds-proxy.proxy-cx04y668wmb4.us-east-2.rds.amazonaws.com"
  }
}
EOF

  aws lambda create-function \
    --function-name "$LAMBDA" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler "index.handler" \
    --zip-file "fileb://${ZIP}" \
    --timeout 30 \
    --memory-size 512 \
    --vpc-config "SubnetIds=${VPC_SUBNETS},SecurityGroupIds=${VPC_SG}" \
    --environment file:///tmp/env.json \
    --region "$REGION" --no-cli-pager \
    --query 'FunctionArn' --output text

  aws lambda wait function-active --function-name "$LAMBDA" --region "$REGION"
  echo "Lambda created and active"
fi

echo ""
echo "🟢 4. Check if API Gateway route exists"
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${LAMBDA}"
EXISTING_ROUTE=$(aws apigatewayv2 get-routes --api-id "$API_ID" --region "$REGION" \
  --query "Items[?RouteKey=='${ROUTE_KEY}'].RouteId | [0]" --output text)

if [ "$EXISTING_ROUTE" != "None" ] && [ -n "$EXISTING_ROUTE" ]; then
  echo "Route exists: $EXISTING_ROUTE"
else
  echo "Creating integration and route"

  INTEGRATION_ID=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version "2.0" \
    --region "$REGION" \
    --query 'IntegrationId' --output text)
  echo "Integration: $INTEGRATION_ID"

  ROUTE_ID=$(aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --route-key "$ROUTE_KEY" \
    --target "integrations/${INTEGRATION_ID}" \
    --region "$REGION" \
    --query 'RouteId' --output text)
  echo "Route: $ROUTE_ID"

  aws lambda add-permission \
    --function-name "$LAMBDA" \
    --statement-id "apigw-${ROUTE_ID}" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*/*/api/subaccount/conversation-start" \
    --region "$REGION" --no-cli-pager \
    --query 'Statement' --output text > /dev/null
  echo "Permission granted"
fi

echo ""
echo "🟢 5. Smoke test (expect 401 with no cookie, confirms endpoint is wired)"
HTTP_CODE=$(curl -s -o /tmp/smoke.json -w "%{http_code}" \
  -X POST "https://api.mysparkplus.app/api/subaccount/conversation-start" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "HTTP $HTTP_CODE"
cat /tmp/smoke.json
echo ""

echo "🟢 END"
