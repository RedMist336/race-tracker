# Race Tracker USB Gateway Quickstart

This config uses a single USB cable between Odroid and TTGO T-Beam for both power and serial data.

## 1. Flash gateway firmware (local Windows machine)

From PowerShell:

```powershell
Set-Location "c:\Users\danie\OneDrive\Personal\Code\PlatformIO\Race Tracker\firmware\gateway"
.\flash_gateway_com7.ps1
```

## 2. Run server with serial ingest (Odroid)

From the server directory:

```bash
npm install
npm run start:serial-usb
```

The startup script auto-selects a stable serial path from `/dev/serial/by-id` when available.

## 3. Install systemd override for persistent boot startup (Odroid)

```bash
cd /path/to/Race\ Tracker/server
chmod +x scripts/*.sh
./scripts/install_systemd_serial_gateway.sh
```

Then apply it:

```bash
sudo systemctl restart race-tracker.service
sudo systemctl status race-tracker.service
```

## Notes

- The server only ingests serial lines prefixed with `RTJSON:`.
- If no `/dev/serial/by-id/*` exists, fallback order is:
  - `/dev/ttyUSB0`
  - `/dev/ttyACM0`
  - `/dev/ttyS1`
  - `/dev/ttyAMA0`
- No runtime testing is required before flashing, as requested.
