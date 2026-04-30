#!/bin/bash
#
# cleanup-vercel.sh
# 
# Phase 9 cleanup: remove Vercel API functions and old patches
# now that AWS is sole API provider.
#
# Removes:
#   - api/                  (47 Vercel serverless functions, replaced by Lambda)
#   - lib/                  (7 helpers used by Vercel api/, replaced by lib-aws/)
#   - cron config in vercel.json  (cron now runs on EventBridge)
#   - patch_bulk_contacts.py, patch_cards_pos.py (old one-off patches, not needed)
#   - index.html.bak, index.html.bak2 (backup files from migration patches)
#
# Keeps:
#   - index.html              (Vercel still serves this)
#   - vercel.json             (still needed for SPA rewrite rule)
#   - lib-aws/, api-aws/      (AWS source of truth)
#   - All deployment scripts
#   - One-time migration helpers (migrate_appointments.js, setup_square_plans.js)

set -e

if [ ! -d "api" ] && [ ! -d "lib" ]; then
  echo "Nothing to clean up - api/ and lib/ already gone"
  exit 0
fi

echo "🟢 BEFORE cleanup"
echo "  api/ exists: $([ -d api ] && echo yes || echo no)"
echo "  lib/ exists: $([ -d lib ] && echo yes || echo no)"
echo "  index.html.bak exists: $([ -f index.html.bak ] && echo yes || echo no)"
echo "  index.html.bak2 exists: $([ -f index.html.bak2 ] && echo yes || echo no)"
echo ""

echo "🟢 Removing Vercel api/ folder (47 serverless functions)"
git rm -rf api/ >/dev/null 2>&1 && echo "  Removed via git" || rm -rf api/

echo ""
echo "🟢 Removing lib/ folder (Vercel-only helpers, replaced by lib-aws/)"
git rm -rf lib/ >/dev/null 2>&1 && echo "  Removed via git" || rm -rf lib/

echo ""
echo "🟢 Removing local backup files"
rm -f index.html.bak index.html.bak2
echo "  Done"

echo ""
echo "🟢 Removing old Python patch files (no longer needed)"
git rm -f patch_bulk_contacts.py patch_cards_pos.py >/dev/null 2>&1 || true
rm -f patch_bulk_contacts.py patch_cards_pos.py
echo "  Done"

echo ""
echo "🟢 Updating vercel.json - removing cron config (EventBridge handles this now)"
cat > vercel.json << 'JSONEOF'
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
JSONEOF
echo "  vercel.json updated"

echo ""
echo "🟢 New vercel.json contents:"
cat vercel.json

echo ""
echo "🟢 AFTER cleanup"
echo "  api/ exists: $([ -d api ] && echo yes || echo no)"
echo "  lib/ exists: $([ -d lib ] && echo yes || echo no)"
echo "  Tracked Python files left:"
git ls-files | grep -E "\.py$" || echo "    none"

echo ""
echo "================================================================"
echo "Cleanup ready to commit. Review with: git status"
echo "================================================================"
