#!/usr/bin/env bash
# eta_map_build.sh — print ETA every 10 minutes while build runs
LOG="$HOME/race-tracking/data/map-build.log"

echo "[$(date -Iseconds)] ETA monitor started."

while pgrep -f build_south_island_mbtiles.py >/dev/null 2>&1; do
  LINE=$(grep '^progress:' "$LOG" 2>/dev/null | tail -n 1)
  if [ -n "$LINE" ]; then
    DONE=$(echo "$LINE" | sed 's/.*progress: \([0-9]*\)\/.*/\1/')
    TOTAL=$(echo "$LINE" | sed 's/.*\/\([0-9]*\) ok.*/\1/')
    RATE=$(echo "$LINE" | sed 's/.*rate=\([0-9.]*\) tiles.*/\1/')
    REMAIN=$((TOTAL - DONE))
    ETA_SECS=$(echo "$REMAIN $RATE" | awk '{if ($2 > 0) printf "%d", $1/$2; else print "0"}')
    ETA_MIN=$((ETA_SECS / 60))
    ETA_HR=$((ETA_MIN / 60))
    ETA_MIN_REM=$((ETA_MIN % 60))
    PCT=$(echo "$DONE $TOTAL" | awk '{if ($2 > 0) printf "%.1f", $1*100/$2; else print "0.0"}')
    echo "[$(date -Iseconds)] Progress: $DONE/$TOTAL (${PCT}%) rate=${RATE}/s  ETA: ${ETA_HR}h ${ETA_MIN_REM}m"
  else
    echo "[$(date -Iseconds)] Waiting for first progress line..."
  fi
  sleep 600
done

echo "[$(date -Iseconds)] Build process finished. Check map-build.done for result."
