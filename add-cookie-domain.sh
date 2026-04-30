#!/bin/bash
#
# Adds COOKIE_DOMAIN=.mysparkplus.app to all 47 myspark-api-* Lambdas.
# This was missed in the previous step (broken loop syntax).

set -e

REGION="us-east-2"
COOKIE_DOMAIN_VALUE=".mysparkplus.app"

echo "🟢 Listing Lambdas..."

# Use --output text with tab separator, then read into an array properly
LAMBDAS_RAW=$(aws lambda list-functions \
  --region "$REGION" \
  --query 'Functions[?starts_with(FunctionName, `myspark-api-`)].FunctionName' \
  --output text)

# Split on whitespace into array
read -ra LAMBDAS <<< "$LAMBDAS_RAW"

TOTAL=${#LAMBDAS[@]}
echo "Found $TOTAL Lambdas"
echo ""

if [ "$TOTAL" -eq "0" ]; then
  echo "ERROR: No Lambdas found"
  exit 1
fi

COUNT=0
SUCCEEDED=0
FAILED=0

for L in "${LAMBDAS[@]}"; do
  COUNT=$((COUNT + 1))
  printf "[%2d/%d] %s ... " "$COUNT" "$TOTAL" "$L"
  
  # Get current env vars (handle case where Environment is null/empty)
  CURRENT_ENV=$(aws lambda get-function-configuration \
    --function-name "$L" \
    --region "$REGION" \
    --query 'Environment.Variables' \
    --output json 2>/dev/null)
  
  # Default to empty object if null
  if [ "$CURRENT_ENV" = "null" ] || [ -z "$CURRENT_ENV" ]; then
    CURRENT_ENV='{}'
  fi
  
  # Merge in COOKIE_DOMAIN
  NEW_ENV=$(echo "$CURRENT_ENV" | jq --arg val "$COOKIE_DOMAIN_VALUE" '. + {"COOKIE_DOMAIN": $val}')
  
  # Build the env config in the format Lambda expects
  ENV_CONFIG=$(jq -n --argjson vars "$NEW_ENV" '{Variables: $vars}')
  
  # Update via file to avoid shell escaping issues with JSON
  TMP_FILE=$(mktemp)
  echo "$ENV_CONFIG" > "$TMP_FILE"
  
  if aws lambda update-function-configuration \
    --function-name "$L" \
    --environment "file://$TMP_FILE" \
    --region "$REGION" \
    --no-cli-pager \
    >/dev/null 2>&1; then
    echo "OK"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "FAILED"
    FAILED=$((FAILED + 1))
    # Show error for first failure
    if [ "$FAILED" = "1" ]; then
      echo "  Debug - first failure details:"
      aws lambda update-function-configuration \
        --function-name "$L" \
        --environment "file://$TMP_FILE" \
        --region "$REGION" \
        --no-cli-pager 2>&1 | head -10 | sed 's/^/    /'
    fi
  fi
  
  rm -f "$TMP_FILE"
  
  # Rate limit: Lambda config updates limited to ~10/sec across the account
  sleep 0.5
done

echo ""
echo "================================"
echo "Done."
echo "  Succeeded: $SUCCEEDED"
echo "  Failed:    $FAILED"
echo "  Total:     $COUNT"
echo "================================"
echo ""
echo "Verify one Lambda has the new env var:"
echo ""
aws lambda get-function-configuration \
  --function-name myspark-api-subaccount-login \
  --region "$REGION" \
  --query 'Environment.Variables.COOKIE_DOMAIN' \
  --output text
