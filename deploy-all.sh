#!/bin/bash
#
# deploy-all.sh
# 
# Creates or updates AWS Lambda functions for each zip in .lambda-builds/.
# Idempotent: creates if missing, updates if present.
#
# Usage: ./deploy-all.sh

set -e

REGION="us-east-2"
ACCOUNT_ID="993939946677"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/myspark-lambda-execution-role"
BUILD_DIR=".lambda-builds"

# VPC config (private subnets where Lambdas talk to RDS)
SUBNET_1="subnet-089d5b9a11be7b4c4"  # myspark-subnet-private1-us-east-2a
SUBNET_2="subnet-00d3f65fe32283e8f"  # myspark-subnet-private2-us-east-2b
SECURITY_GROUP="sg-02cec0029eb95efd9"  # myspark-lambda-sg

# Common environment variables for ALL Lambdas
# RDS connection vars are required by lib/db.js for IAM auth via the proxy.
# Other vars are read from the same Lambda env on demand by the endpoints.
# Sensitive secrets (Square, Resend, Twilio API keys) are NOT included here -
# you'll set them via the AWS Console one time, or with a separate script.
COMMON_ENV='Variables={RDS_PROXY_HOST=myspark-rds-proxy.proxy-cx04y668wmb4.us-east-2.rds.amazonaws.com,RDS_PORT=5432,RDS_DATABASE=myspark,RDS_USER=myspark_admin,ALLOWED_ORIGINS=https://mysparkplus.app\,https://www.mysparkplus.app\,https://aws.mysparkplus.app}'

if ! command -v aws &> /dev/null; then
  echo "ERROR: aws CLI not found." >&2
  exit 1
fi

ZIPS=$(ls "$BUILD_DIR"/*.zip 2>/dev/null | sort)
if [ -z "$ZIPS" ]; then
  echo "No zips found in $BUILD_DIR. Run build-all.sh first." >&2
  exit 1
fi

TOTAL=$(echo "$ZIPS" | wc -l | tr -d ' ')
COUNT=0
CREATED=0
UPDATED=0
FAILED=0

echo "Deploying $TOTAL Lambda functions to region $REGION..."
echo ""

for zip in $ZIPS; do
  COUNT=$((COUNT + 1))
  name=$(basename "$zip" .zip)
  
  printf "[%2d/%d] %s ... " "$COUNT" "$TOTAL" "$name"
  
  # Check if function exists
  if aws lambda get-function --function-name "$name" --region "$REGION" >/dev/null 2>&1; then
    # Update existing - just the code (config stays the same)
    if aws lambda update-function-code \
        --function-name "$name" \
        --zip-file "fileb://$zip" \
        --region "$REGION" \
        --no-cli-pager \
        >/dev/null 2>&1; then
      echo "updated"
      UPDATED=$((UPDATED + 1))
    else
      echo "FAILED to update"
      FAILED=$((FAILED + 1))
    fi
  else
    # Create new
    if aws lambda create-function \
        --function-name "$name" \
        --runtime nodejs20.x \
        --architectures arm64 \
        --role "$ROLE_ARN" \
        --handler index.handler \
        --zip-file "fileb://$zip" \
        --timeout 30 \
        --memory-size 512 \
        --vpc-config "SubnetIds=${SUBNET_1},${SUBNET_2},SecurityGroupIds=${SECURITY_GROUP}" \
        --environment "$COMMON_ENV" \
        --region "$REGION" \
        --no-cli-pager \
        >/dev/null 2>&1; then
      echo "created"
      CREATED=$((CREATED + 1))
    else
      echo "FAILED to create"
      FAILED=$((FAILED + 1))
      # Show the actual error for the first failure so it's debuggable
      if [ "$FAILED" = "1" ]; then
        echo ""
        echo "First failure details:"
        aws lambda create-function \
          --function-name "$name" \
          --runtime nodejs20.x \
          --architectures arm64 \
          --role "$ROLE_ARN" \
          --handler index.handler \
          --zip-file "fileb://$zip" \
          --timeout 30 \
          --memory-size 512 \
          --vpc-config "SubnetIds=${SUBNET_1},${SUBNET_2},SecurityGroupIds=${SECURITY_GROUP}" \
          --environment "$COMMON_ENV" \
          --region "$REGION" \
          --no-cli-pager 2>&1 | head -20
        echo ""
      fi
    fi
  fi
  
  # Brief pause to avoid Lambda API rate limits (default is ~10 req/sec for create/update)
  sleep 0.3
done

echo ""
echo "================================"
echo "Done."
echo "  Created:  $CREATED"
echo "  Updated:  $UPDATED"
echo "  Failed:   $FAILED"
echo "  Total:    $COUNT"
echo "================================"

if [ "$FAILED" -gt "0" ]; then
  exit 1
fi
