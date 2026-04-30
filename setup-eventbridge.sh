#!/bin/bash
#
# setup-eventbridge.sh
#
# Creates EventBridge schedules for the 3 cron Lambdas.
# Idempotent: safe to re-run.

set -e

REGION="us-east-2"
ACCOUNT_ID="993939946677"
ROLE_NAME="myspark-eventbridge-role"

if ! command -v aws &> /dev/null; then
  echo "ERROR: aws CLI not found." >&2
  exit 1
fi

echo "================================================================"
echo "Setting up EventBridge schedules"
echo "================================================================"

# ========================================
# Step 1: Create IAM role for EventBridge to invoke Lambdas
# ========================================
echo ""
echo "Step 1: IAM role for EventBridge..."

ROLE_ARN=$(aws iam get-role \
  --role-name "$ROLE_NAME" \
  --query 'Role.Arn' \
  --output text 2>/dev/null) || ROLE_ARN=""

if [ -z "$ROLE_ARN" ]; then
  echo "  Creating IAM role: $ROLE_NAME"
  
  TRUST_POLICY='{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "events.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'
  
  ROLE_ARN=$(aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Allows EventBridge to invoke MySpark+ cron Lambdas" \
    --query 'Role.Arn' \
    --output text)
  
  # Attach inline policy allowing Lambda invocation
  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name invoke-cron-lambdas \
    --policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Action": "lambda:InvokeFunction",
        "Resource": [
          "arn:aws:lambda:'"$REGION"':'"$ACCOUNT_ID"':function:myspark-api-cron-*"
        ]
      }]
    }'
  
  echo "  Created role: $ROLE_ARN"
  echo "  Waiting 10 seconds for IAM role propagation..."
  sleep 10
else
  echo "  Using existing role: $ROLE_ARN"
fi

# ========================================
# Step 2: Define schedules and create rules
# ========================================
echo ""
echo "Step 2: Creating EventBridge rules..."
echo ""

# Schedule definitions: rule_name | lambda_name | description | schedule_expression
SCHEDULES=(
  "myspark-cron-run-billing|myspark-api-cron-run-billing|Daily billing run at 9:00 AM UTC|cron(0 9 * * ? *)"
  "myspark-cron-reminders|myspark-api-cron-reminders|Hourly appointment reminder check|cron(0 * * * ? *)"
  "myspark-cron-purge-audit-log|myspark-api-cron-purge-audit-log|Monthly audit log purge - 1st of month at 4:00 AM UTC|cron(0 4 1 * ? *)"
)

CREATED=0
UPDATED=0
FAILED=0

for entry in "${SCHEDULES[@]}"; do
  IFS='|' read -r RULE_NAME LAMBDA_NAME DESCRIPTION SCHEDULE <<< "$entry"
  
  printf "[%s]\n" "$RULE_NAME"
  printf "  Lambda:   %s\n" "$LAMBDA_NAME"
  printf "  Schedule: %s\n" "$SCHEDULE"
  printf "  Action:   "
  
  # Check if rule already exists
  EXISTING=$(aws events describe-rule \
    --name "$RULE_NAME" \
    --region "$REGION" \
    --query 'Name' \
    --output text 2>/dev/null) || EXISTING=""
  
  if [ -n "$EXISTING" ]; then
    # Update existing
    aws events put-rule \
      --name "$RULE_NAME" \
      --schedule-expression "$SCHEDULE" \
      --description "$DESCRIPTION" \
      --state ENABLED \
      --region "$REGION" \
      >/dev/null
    UPDATED=$((UPDATED + 1))
    echo "updated"
  else
    # Create new
    aws events put-rule \
      --name "$RULE_NAME" \
      --schedule-expression "$SCHEDULE" \
      --description "$DESCRIPTION" \
      --state ENABLED \
      --region "$REGION" \
      >/dev/null
    CREATED=$((CREATED + 1))
    echo "created"
  fi
  
  # Set the Lambda as the target
  LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$LAMBDA_NAME"
  
  aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "Id=1,Arn=$LAMBDA_ARN" \
    --region "$REGION" \
    >/dev/null
  
  # Add permission for EventBridge to invoke the Lambda
  STATEMENT_ID="eventbridge-${RULE_NAME}"
  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "$STATEMENT_ID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$RULE_NAME" \
    --region "$REGION" \
    >/dev/null 2>&1 || true  # ignore if already exists
  
  echo "  Target:   set to Lambda"
  echo "  Permission: granted to EventBridge"
  echo ""
done

echo "================================================================"
echo "EventBridge setup complete"
echo "================================================================"
echo "  Rules created:  $CREATED"
echo "  Rules updated:  $UPDATED"
echo "  Failed:         $FAILED"
echo ""
echo "  View in console:"
echo "    https://us-east-2.console.aws.amazon.com/events/home?region=us-east-2#/rules"
echo ""
echo "  All schedules in UTC. Convert to your local time:"
echo "    9:00 AM UTC = 5:00 AM EDT / 4:00 AM EST"
echo "    4:00 AM UTC = 12:00 AM EDT / 11:00 PM EST (previous day)"
echo ""
echo "================================================================"
