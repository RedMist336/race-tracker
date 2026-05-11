#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT_PATH="${SERIAL_GATEWAY_PORT:-}"
if [ -z "$PORT_PATH" ]; then
  PORT_PATH="$($SCRIPT_DIR/print_gateway_serial_path.sh)"
fi

export SERIAL_GATEWAY_ENABLED="${SERIAL_GATEWAY_ENABLED:-1}"
export SERIAL_GATEWAY_PORT="$PORT_PATH"
export SERIAL_GATEWAY_BAUD="${SERIAL_GATEWAY_BAUD:-115200}"
export SERIAL_GATEWAY_PREFIX="${SERIAL_GATEWAY_PREFIX:-RTJSON:}"

echo "[serial-start] SERIAL_GATEWAY_PORT=$SERIAL_GATEWAY_PORT"
cd "$SERVER_DIR"
exec node src/index.js
