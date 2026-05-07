#!/bin/bash
# MySpark+ CloudWatch alarms setup.
# Idempotent: safe to re-run. Discovers Lambda names by pattern so it survives renames.
# Creates one SNS topic + email subscription, then 12 alarms.
#
# Usage: bash cloudwatch-alarms.sh

set -e

REGION=us-east-2
EMAIL=patrick@litbiz.io
TOPIC_NAME=myspark-alerts

echo "🟢 1. SNS topic"
TOPIC_ARN=$(aws sns create-topic \
  --name "$TOPIC_NAME" \
  --region "$REGION" \
  --query 'TopicArn' \
  --output text)
echo "  $TOPIC_ARN"

echo ""
echo "🟢 2. Email subscription (idempotent)"
EXISTING=$(aws sns list-subscriptions-by-topic \
  --topic-arn "$TOPIC_ARN" \
  --region "$REGION" \
  --query "Subscriptions[?Endpoint=='$EMAIL'].SubscriptionArn" \
  --output text)
if [ -z "$EXISTING" ] || [ "$EXISTING" = "None" ]; then
  aws sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol email \
    --notification-endpoint "$EMAIL" \
    --region "$REGION" \
    --no-cli-pager > /dev/null
  echo "  subscribed $EMAIL (PENDING - check inbox to confirm)"
else
  echo "  already subscribed: $EXISTING"
fi

echo ""
echo "🟢 3. Discover Lambda names"
LAMBDAS=$(aws lambda list-functions --region "$REGION" --query 'Functions[].FunctionName' --output text 2>/dev/null | tr '\t' '\n')

discover() {
  echo "$LAMBDAS" | grep -E "^${1}$" | head -1
}

create_alarm() {
  local name=$1
  local description=$2
  local lambda_name=$3
  local period=$4
  local eval_periods=$5
  local threshold=$6

  if [ -z "$lambda_name" ]; then
    echo "  ⚠️  SKIP $name (Lambda not discovered)"
    return
  fi

  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "$name" \
    --alarm-description "$description" \
    --metric-name Errors \
    --namespace AWS/Lambda \
    --statistic Sum \
    --period "$period" \
    --evaluation-periods "$eval_periods" \
    --threshold "$threshold" \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --dimensions "Name=FunctionName,Value=$lambda_name" \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN" \
    --no-cli-pager > /dev/null
  echo "  ok $name -> $lambda_name"
}

echo ""
echo "🟢 4. Cron failure alarms"
create_alarm \
  "myspark-subscription-charge-cron-errors" \
  "Subscription charge cron had >=1 error in 24h. Check /aws/lambda/myspark-cron-subscriptions-charge logs." \
  "$(discover 'myspark-cron-subscriptions-charge')" \
  86400 1 1

create_alarm \
  "myspark-saas-billing-cron-errors" \
  "SaaS run-billing cron had >=1 error in 24h. Check /aws/lambda/myspark-api-cron-run-billing logs." \
  "$(discover 'myspark-api-cron-run-billing')" \
  86400 1 1

create_alarm \
  "myspark-purge-audit-cron-errors" \
  "Audit log purge cron had >=1 error. Monthly cron, so missing data is normal." \
  "$(discover 'myspark-api-cron-purge-audit-log')" \
  86400 1 1

create_alarm \
  "myspark-reminders-cron-errors" \
  "Reminders cron had >=3 errors in 6h. Hourly cron tolerates some retryable noise." \
  "$(discover 'myspark-api-cron-reminders')" \
  21600 1 3

echo ""
echo "🟢 5. Money + auth alarms"
create_alarm \
  "myspark-subscription-create-errors" \
  "Subscription create Lambda had >=1 error in 5min. Customer-facing, urgent." \
  "$(discover 'myspark-api-subaccount-subscriptions-create')" \
  300 1 1

create_alarm \
  "myspark-square-callback-errors" \
  "Square OAuth callback had >=1 error in 15min. Indicates broken Square integration." \
  "$(discover 'myspark-api-square-callback')" \
  900 1 1

create_alarm \
  "myspark-login-errors-spike" \
  "Login Lambda had >=10 errors in 15min. Could be brute-force, bug, or DB issue." \
  "$(discover 'myspark-api-subaccount-login')" \
  900 1 10

create_alarm \
  "myspark-reset-password-errors" \
  "Reset password Lambda had >=3 errors in 15min. Indicates email or token issue." \
  "$(discover 'myspark-api-auth-reset-password')" \
  900 1 3

create_alarm \
  "myspark-booking-submit-errors" \
  "Booking submit Lambda had >=1 error in 5min. Customer-facing, urgent." \
  "$(discover 'myspark-api-booking-submit')" \
  300 1 1

echo ""
echo "🟢 6. Billing operation alarms"
create_alarm \
  "myspark-billing-swap-plan-errors" \
  "Plan swap Lambda had >=1 error in 15min. Touches money, urgent." \
  "$(discover 'myspark-api-billing-swap-plan')" \
  900 1 1

create_alarm \
  "myspark-billing-reactivate-errors" \
  "Reactivate Lambda had >=1 error in 15min. Touches money, urgent." \
  "$(discover 'myspark-api-billing-reactivate')" \
  900 1 1

create_alarm \
  "myspark-billing-setup-errors" \
  "Setup billing Lambda had >=1 error in 15min. Touches money, urgent." \
  "$(discover 'myspark-api-billing-setup-billing')" \
  900 1 1

echo ""
echo "🟢 7. Summary"
COUNT=$(aws cloudwatch describe-alarms \
  --region "$REGION" \
  --alarm-name-prefix "myspark-" \
  --query 'length(MetricAlarms)' \
  --output text)
echo "  Total myspark-* alarms: $COUNT"

aws cloudwatch describe-alarms \
  --region "$REGION" \
  --alarm-name-prefix "myspark-" \
  --query 'MetricAlarms[].[AlarmName,StateValue]' \
  --output table

echo ""
echo "✅ Done. Confirm the SNS subscription email if you haven't already."
