# OTA Updates (Gateway + Trackers)

OTA is implemented as a maintenance mode so race-time behavior is unchanged.

## Enter OTA mode

- Tracker: hold the tracker alert button during boot for at least `OTA_BOOT_HOLD_MS`.
- Gateway: hold the BOOT button (GPIO0) during boot for at least `OTA_BOOT_HOLD_MS`.

When OTA mode starts, the device connects to WiFi and prints OTA readiness over serial.

## Upload via PlatformIO

Tracker OTA env:

```bash
cd firmware/tracker
pio run -e tracker_ota -t upload
```

Gateway OTA env:

```bash
cd firmware/gateway
pio run -e gateway_ota -t upload
```

Set `upload_port` in each `platformio.ini` OTA environment to the IP shown in OTA-mode serial logs.

## Configuration knobs

Tracker config:

- `OTA_ENABLED`
- `OTA_BOOT_HOLD_MS`
- `OTA_WIFI_CONNECT_TIMEOUT_MS`
- `OTA_HOSTNAME_PREFIX`
- `OTA_PASSWORD`

Gateway config:

- `OTA_ENABLED`
- `OTA_BOOT_HOLD_PIN`
- `OTA_BOOT_HOLD_MS`
- `OTA_WIFI_CONNECT_TIMEOUT_MS`
- `OTA_HOSTNAME`
- `OTA_PASSWORD`
