#!/usr/bin/env bash
# MySpark+ Downloads cleanup. Detects stray repo files in ~/Downloads,
# auto-archives duplicates, quarantines diffs, leaves the repo untouched.
# Re-runnable safely. Logs to docs/cleanup-logs/.
#
# Usage:
#   scripts/cleanup-downloads.sh            # do it
#   scripts/cleanup-downloads.sh --dry-run  # preview, no moves
#
# Author: Thalos
set -eo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

REPO="$HOME/Downloads/myspark-crm-repo"
DATE_STAMP=$(date +%Y-%m-%d)
ARCHIVE="$HOME/Downloads/_cleanup_${DATE_STAMP}"
QUAR="$ARCHIVE/quarantine"
LOG_DIR="$REPO/docs/cleanup-logs"
LOG="$LOG_DIR/${DATE_STAMP}-manifest.txt"
REVIEW="$LOG_DIR/${DATE_STAMP}-needs-review.txt"

if [ $DRY_RUN -eq 1 ]; then
  echo "🟡 DRY RUN. No files will be moved."
fi

echo "🟢 Cleanup run: $(date)"
echo "  Repo:    $REPO"
echo "  Archive: $ARCHIVE"
echo "  Logs:    $LOG_DIR"
echo ""

# Auto-prune old archives (>30 days). Just notify, don't delete unattended.
OLD=$(find "$HOME/Downloads" -maxdepth 1 -type d -name "_cleanup_*" -mtime +30 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "🟡 Cleanup archives older than 30 days (consider deleting):"
  echo "$OLD" | sed 's/^/    /'
  echo ""
fi

if [ $DRY_RUN -eq 0 ]; then
  mkdir -p "$QUAR" "$LOG_DIR"
  : > "$LOG"
  : > "$REVIEW"
  echo "Cleanup run: $(date)" >> "$LOG"
fi

# Collect stray files
STRAY=()
while IFS= read -r f; do STRAY+=("$f"); done < <(
  find "$HOME/Downloads" -maxdepth 1 -type f \( -name '*.js' -o -name '*.sh' \) ! -name 'cleanup.sh'
)
for dir in api-aws lib-aws aws-config sql; do
  if [ -d "$HOME/Downloads/$dir" ]; then
    while IFS= read -r f; do STRAY+=("$f"); done < <(
      find "$HOME/Downloads/$dir" -type f ! -path '*/.*'
    )
  fi
done

if [ ${#STRAY[@]} -eq 0 ]; then
  echo "🟢 Nothing stray to clean. Exiting."
  exit 0
fi

echo "🟢 Found ${#STRAY[@]} stray file(s) to evaluate"
echo ""

archive_stray() {
  stray="$1"
  rel="${stray#$HOME/Downloads/}"
  dest="$QUAR/$rel"
  if [ $DRY_RUN -eq 0 ]; then
    mkdir -p "$(dirname "$dest")"
    mv "$stray" "$dest"
  fi
}

resolve_target() {
  stray="$1"
  base=$(basename "$stray")
  case "$stray" in
    "$HOME/Downloads/api-aws/"*|"$HOME/Downloads/lib-aws/"*|"$HOME/Downloads/aws-config/"*|"$HOME/Downloads/sql/"*)
      echo "$REPO${stray#$HOME/Downloads}"
      return ;;
  esac
  case "$base" in
    subscriptions-charge.js|run-billing.js|reminders.js)
      echo "$REPO/api-aws/cron/$base"; return ;;
  esac
  case "$base" in
    deploy-*.sh) echo "ARCHIVE"; return ;;
  esac
  found=$(find "$REPO/api-aws" "$REPO/lib-aws" "$REPO/aws-config" "$REPO/sql" \
    -type f -name "$base" 2>/dev/null | head -1)
  if [ -n "$found" ]; then echo "$found"; return; fi
  echo "UNKNOWN"
}

for stray in "${STRAY[@]}"; do
  rel="${stray#$HOME/Downloads/}"
  target=$(resolve_target "$stray")
  case "$target" in
    UNKNOWN)
      echo "[REVIEW] $rel  (no match in repo)"
      [ $DRY_RUN -eq 0 ] && echo "[REVIEW] $rel  no match in repo" >> "$REVIEW"
      ;;
    ARCHIVE)
      echo "[ARCHIVE] $rel  (throwaway)"
      archive_stray "$stray"
      [ $DRY_RUN -eq 0 ] && echo "ARCHIVED-THROWAWAY: $rel" >> "$LOG"
      ;;
    *)
      if [ ! -f "$target" ]; then
        echo "[NEW->REPO] $rel  ->  ${target#$REPO/}"
        if [ $DRY_RUN -eq 0 ]; then
          mkdir -p "$(dirname "$target")"
          mv "$stray" "$target"
          echo "NEW->REPO: $rel -> ${target#$REPO/}" >> "$LOG"
        fi
      elif cmp -s "$stray" "$target"; then
        echo "[DUP] $rel  (matches repo)"
        archive_stray "$stray"
        [ $DRY_RUN -eq 0 ] && echo "DUPLICATE-ARCHIVED: $rel matches ${target#$REPO/}" >> "$LOG"
      else
        # Compare timestamps for the human
        s_size=$(wc -c < "$stray" | tr -d ' ')
        r_size=$(wc -c < "$target" | tr -d ' ')
        if [ "$stray" -nt "$target" ]; then
          tag="STRAY-NEWER"
        else
          tag="REPO-NEWER"
        fi
        quar_path="$QUAR/_DIFFERS/$rel"
        echo "[DIFF] $rel  ($tag, stray ${s_size}b vs repo ${r_size}b)"
        if [ $DRY_RUN -eq 0 ]; then
          mkdir -p "$(dirname "$quar_path")"
          mv "$stray" "$quar_path"
          diff -u "$target" "$quar_path" > "$quar_path.diff" 2>/dev/null || true
          echo "DIFFERS-$tag: $rel quarantined; repo ${target#$REPO/} untouched" >> "$LOG"
          echo "[DIFF] $rel  $tag, diff at $quar_path.diff" >> "$REVIEW"
        fi
      fi
      ;;
  esac
done

# Remove empty shadow folders
if [ $DRY_RUN -eq 0 ]; then
  for dir in api-aws lib-aws aws-config sql; do
    if [ -d "$HOME/Downloads/$dir" ] && [ -z "$(find "$HOME/Downloads/$dir" -type f 2>/dev/null)" ]; then
      rm -rf "$HOME/Downloads/$dir"
      echo "REMOVED-EMPTY-SHADOW: ~/Downloads/$dir" >> "$LOG"
    fi
  done
fi

echo ""
if [ $DRY_RUN -eq 1 ]; then
  echo "🟡 Dry run complete. Re-run without --dry-run to execute."
  exit 0
fi

echo "🟢 Done."
echo "  Manifest:     $LOG"
echo "  Needs review: $REVIEW"
echo "  Quarantine:   $QUAR"
echo ""
echo "  Counts:"
echo "    Moved into repo:           $(grep -c '^NEW->REPO' "$LOG" 2>/dev/null || echo 0)"
echo "    Quarantined as duplicate:  $(grep -c '^DUPLICATE-ARCHIVED' "$LOG" 2>/dev/null || echo 0)"
echo "    Quarantined (stray newer): $(grep -c '^DIFFERS-STRAY-NEWER' "$LOG" 2>/dev/null || echo 0)"
echo "    Quarantined (repo newer):  $(grep -c '^DIFFERS-REPO-NEWER' "$LOG" 2>/dev/null || echo 0)"
echo "    Throwaway archived:        $(grep -c '^ARCHIVED-THROWAWAY' "$LOG" 2>/dev/null || echo 0)"
echo "    Unknown (no match):        $([ -f "$REVIEW" ] && wc -l < "$REVIEW" | tr -d ' ' || echo 0)"
echo ""
echo "  ⚠️  STRAY-NEWER files indicate possible unsaved work. Review diffs before deleting archive."
