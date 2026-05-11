#!/usr/bin/env bash
set -euo pipefail

LOG="$HOME/race-tracking/data/map-build.log"
DONE_FILE="$HOME/race-tracking/data/map-build.done"
STATUS_FILE="$HOME/race-tracking/data/map-build.status"

while pgrep -f build_south_island_mbtiles.py >/dev/null 2>&1; do
  date -Iseconds > "$STATUS_FILE"
  sleep 30
done

if grep -q '^Done:' "$LOG" 2>/dev/null; then
  TS="$(date -Iseconds)"
  MSG="South Island map build finished at $TS"

  if sudo -n systemctl restart race-tracking >/dev/null 2>&1; then
    MSG="$MSG; race-tracking service restarted"
  else
    MSG="$MSG; restart skipped (sudo permissions required)"
  fi
else
  TS="$(date -Iseconds)"
  MSG="South Island map build stopped before completion at $TS"
fi

echo "$MSG" | tee "$DONE_FILE"
logger -t race-tracking "$MSG" || true
wall "$MSG" || true
