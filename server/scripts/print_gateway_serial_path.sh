#!/usr/bin/env bash
set -euo pipefail

# Prefer stable /dev/serial/by-id symlink when available.
if compgen -G '/dev/serial/by-id/*' > /dev/null; then
  ls -1 /dev/serial/by-id | sed 's#^#/dev/serial/by-id/#' | head -n1
  exit 0
fi

# Fallbacks for USB/UART serial devices.
for dev in /dev/ttyUSB0 /dev/ttyACM0 /dev/ttyS1 /dev/ttyAMA0; do
  if [ -e "$dev" ]; then
    echo "$dev"
    exit 0
  fi
done

echo "No serial gateway device found" >&2
exit 1
