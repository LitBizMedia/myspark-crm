#!/bin/bash
#
# build-all.sh v2
# 
# Improvements over v1:
#   - Uses unique work dir per run (no collision if a previous run died midway)
#   - Robust cleanup that handles macOS file lock weirdness
#   - --no-bin-links on npm install prevents some Finder/Spotlight issues
#   - Continues on individual failures instead of aborting whole run
#   - Final summary shows what succeeded/failed

set -e

REPO_ROOT="$(pwd)"
API_DIR="api-aws"
LIB_DIR="lib-aws"
BUILD_DIR=".lambda-builds"
RUN_ID=$(date +%s)
WORK_BASE="$BUILD_DIR/.work-$RUN_ID"

if [ ! -d "$API_DIR" ]; then
  echo "Error: $API_DIR not found. Run from repo root." >&2
  exit 1
fi
if [ ! -d "$LIB_DIR" ]; then
  echo "Error: $LIB_DIR not found." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

# Clean up any stale work dirs from previous failed runs (best effort)
echo "Cleaning up old work directories..."
find "$BUILD_DIR" -maxdepth 1 -name ".work-*" -type d 2>/dev/null | while read d; do
  rm -rf "$d" 2>/dev/null || true
done

# Install shared deps if needed
if [ ! -d ".lambda-deps/node_modules" ] || [ ! -d ".lambda-deps/node_modules/@aws-sdk/client-secrets-manager" ]; then
  echo "Installing shared Lambda deps..."
  mkdir -p .lambda-deps
  cd .lambda-deps
  cat > package.json << 'PKGEOF'
{
  "name": "myspark-lambda-deps",
  "version": "1.0.0",
  "dependencies": {
    "@aws-sdk/rds-signer": "^3.x",
    "@aws-sdk/client-s3": "^3.x",
    "@aws-sdk/s3-request-presigner": "^3.x",
    "@aws-sdk/client-secrets-manager": "^3.x",
    "bcryptjs": "^3.0.3",
    "pg": "^8.x"
  }
}
PKGEOF
  npm install --silent --no-bin-links
  cd "$REPO_ROOT"
fi

ENDPOINTS=$(find "$API_DIR" -name "*.js" -type f | sort)
TOTAL=$(echo "$ENDPOINTS" | wc -l | tr -d ' ')
COUNT=0
SUCCEEDED=0
FAILED=0
FAILED_LIST=""

mkdir -p "$WORK_BASE"

echo "Building $TOTAL endpoints..."
echo ""

for endpoint in $ENDPOINTS; do
  COUNT=$((COUNT + 1))
  
  rel="${endpoint#$API_DIR/}"
  base="${rel%.js}"
  flat=$(echo "$base" | tr '/' '-')
  full_name="myspark-api-${flat}"
  
  printf "[%2d/%d] %s ... " "$COUNT" "$TOTAL" "$full_name"
  
  WORK="$WORK_BASE/$full_name"
  mkdir -p "$WORK/lib"
  
  cp "$endpoint" "$WORK/index.js"
  cp "$LIB_DIR"/*.js "$WORK/lib/"
  cp -R .lambda-deps/node_modules "$WORK/node_modules"
  
  cat > "$WORK/package.json" << PKG
{
  "name": "$full_name",
  "version": "1.0.0",
  "main": "index.js"
}
PKG
  
  ZIP_PATH="$REPO_ROOT/$BUILD_DIR/$full_name.zip"
  rm -f "$ZIP_PATH"
  
  cd "$WORK"
  if zip -r -q "$ZIP_PATH" . -x "*.DS_Store" 2>/dev/null; then
    cd "$REPO_ROOT"
    size=$(du -h "$ZIP_PATH" 2>/dev/null | cut -f1)
    echo "OK ($size)"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    cd "$REPO_ROOT"
    echo "FAILED"
    FAILED=$((FAILED + 1))
    FAILED_LIST="$FAILED_LIST $full_name"
  fi
  
  # DON'T delete work dir per-iteration - leave for batch cleanup at end.
  # macOS gets cranky about removing node_modules during active filesystem activity.
done

# Now clean up the whole batch at once at the end
echo ""
echo "Cleaning up work directories..."
rm -rf "$WORK_BASE" 2>/dev/null || {
  echo "(some files held briefly - retrying...)" >&2
  sleep 2
  rm -rf "$WORK_BASE" 2>/dev/null || {
    echo "(work dir still held - this is fine, will get cleaned next run)" >&2
  }
}

echo ""
echo "================================"
echo "Build complete:"
echo "  Succeeded: $SUCCEEDED"
echo "  Failed:    $FAILED"
echo "  Total:     $COUNT"
if [ "$FAILED" -gt "0" ]; then
  echo ""
  echo "Failed endpoints:$FAILED_LIST"
fi
echo "================================"
echo ""
ls -lh "$BUILD_DIR"/*.zip 2>/dev/null | tail -10
