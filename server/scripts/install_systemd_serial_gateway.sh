#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="race-tracker"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [ ! -f "$UNIT_PATH" ]; then
  cat >&2 <<EOF
Systemd unit not found at: $UNIT_PATH
Create your base service first, then rerun this script.
EOF
  exit 1
fi

sudo mkdir -p "/etc/systemd/system/${SERVICE_NAME}.service.d"

SERIAL_PORT="$($SCRIPT_DIR/print_gateway_serial_path.sh || true)"
if [ -z "$SERIAL_PORT" ]; then
  SERIAL_PORT="/dev/ttyUSB0"
fi

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service.d/override.conf" > /dev/null <<EOF
[Service]
Environment=SERIAL_GATEWAY_ENABLED=1
Environment=SERIAL_GATEWAY_PORT=${SERIAL_PORT}
Environment=SERIAL_GATEWAY_BAUD=115200
Environment=SERIAL_GATEWAY_PREFIX=RTJSON:
WorkingDirectory=${SERVER_DIR}
ExecStart=
ExecStart=/usr/bin/env bash ${SCRIPT_DIR}/start_serial_gateway.sh
EOF

sudo systemctl daemon-reload

echo "[systemd] Installed override for ${SERVICE_NAME}.service"
echo "[systemd] SERIAL_GATEWAY_PORT=${SERIAL_PORT}"
echo "[systemd] Apply with: sudo systemctl restart ${SERVICE_NAME}.service"
