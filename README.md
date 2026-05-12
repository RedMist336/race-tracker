# Race Tracker

A real-time GPS-based race tracking and alert system using LoRa communication and a web dashboard. For additional detail, over and above the Lora link budget, the tracker can attach to a wifi network and automatically upload all GPS tracking data to the web dashboard. 

## Overview

Race Tracker is a complete system for tracking racing vehicles in real-time with:
- **LoRa-based GPS position reporting** from mobile trackers
- **Driver alert/incident detection** system
- **Web dashboard** for live tracking and race management
- **Wifi upload of detail tracking data** for offline detail analysis of GPS path. 
- **ESP32 OTA firmware updates** for both gateway and trackers
- **Serial gateway bridge** connecting LoRa network to centralized server

## Features

### (Current)
- ✅ Real-time GPS position tracking via LoRa (915.2 MHz AU915 region)
- ✅ Driver alert/incident system with button controls
- ✅ Web-based live dashboard with map tiles
- ✅ OTA firmware update capability for all devices
- ✅ Serial USB gateway bridge to server
- ✅ Battery monitoring on all trackers
- ✅ Automatic GPS registration and synchronization

### v2 (Planned)
- 🔄 Lap timing and finish line detection
- 🔄 Race scoring and leaderboard
- 🔄 Advanced analytics and telemetry
- 🔄 Multi-race event management

## Hardware Requirements

### Tracker Units (Per Vehicle)
- **TTGo T-Beam v1.2** (ESP32 + LoRa SX1276)
- **GPS**: NEO-6M module
- **Battery**: Li-Po 3.7V (internal AXP2101/AXP192 charging)
- **Button**: GPIO 2 for alerts and OTA mode

### Gateway Unit
- **TTGo T-Beam v1.2** (ESP32 + LoRa SX1276)
- **USB cable** for power and serial connection to server

### Server
- **Odroid** or Linux-based SBC (tested on Odroid C4)
- **Node.js 14+** runtime
- **USB serial port** connection from gateway

## Pin Configuration

### Tracker & Gateway LoRa
```
MOSI=27, MISO=19, SCK=5
NSS=18, RST=23, DIO0=26, DIO1=33
```

### GPS (Tracker only)
```
RX=34, TX=12, 9600 baud
```

### Power Management (I2C)
```
SDA=21, SCL=22 (AXP2101/AXP192)
```

### NeoPixel LED (Tracker only)
```
GPIO=15, 5×5 matrix, brightness 32/255
```

## LoRa Configuration

| Parameter | Value |
|-----------|-------|
| Frequency | 915.2 MHz (AU915) |
| Bandwidth | 125.0 kHz |
| Spreading Factor | 7 |
| Coding Rate | 5 |
| TX Power | 14 dBm |
| Sync Word | 0x34 |
| CRC | Enabled |
| Preamble | 8 symbols |

## Installation

### 1. Firmware Setup

#### Prerequisites
- PlatformIO (VS Code extension or CLI)
- Python 3.7+

#### Flash Gateway
```bash
cd firmware/gateway
pio run -e gateway -t upload --upload-port COM7
```

#### Flash Tracker (per unit)
Edit `firmware/tracker/include/config.h` to set unique `CAR_ID`:
```cpp
#define CAR_ID 15              // Change for each unit
#define TRACKER_NAME "U15"
```

Then flash:
```bash
cd firmware/tracker
pio run -e tracker -t upload --upload-port COM9
```

### 2. Server Setup

#### On Odroid/Linux server:
```bash
cd server
npm install
export SERIAL_GATEWAY_ENABLED=1
export SERIAL_GATEWAY_PORT=/dev/serial/by-id/usb-1a86_USB_Single_Serial_*
node src/index.js
```

#### Auto-start with systemd:
```bash
sudo ./server/scripts/install_systemd_serial_gateway.sh
sudo systemctl start race-tracking
sudo systemctl status race-tracking
```

### 3. Dashboard Access

Open browser to: `http://192.168.0.1:3000` (or server IP:3000)

## Operation

### Tracker Operation States

1. **STATE_INIT** → Acquire GPS fix
2. **STATE_GPS_ACQUIRING** → Wait for valid fix + altitude
3. **STATE_REGISTERING** → Send registration, wait for ACK from gateway
4. **STATE_OPERATIONAL** → Send GPS updates every 2 seconds

### Button Controls

| Action | Duration | Effect |
|--------|----------|--------|
| Single press | < 2s | No effect |
| Hold | 2s | Send driver alert |
| Hold | 20s | Upload GPS logs to server |

### OTA Firmware Updates

#### Enter OTA Mode
Hold boot button (GPIO 2) for 3 seconds during power-on. Device connects to WiFi (`CORC` / `LetsRace`).

#### Deploy Update
```bash
cd firmware/tracker
pio run -e tracker_ota -t upload
```

## Protocol

### LoRa Frame Types
```c
FRAME_GPS_UPDATE    = 0x01  // Position update (19 bytes)
FRAME_REGISTER      = 0x05  // Registration request (16 bytes)
FRAME_REGISTER_ACK  = 0x06  // Registration acknowledgement
FRAME_SYNC          = 0x04  // Sync packet with race config
FRAME_ALERT         = 0x02  // Driver alert
```

### Serial Gateway Protocol
Gateway transmits JSON to server via USB with prefix `RTJSON:`:
```json
RTJSON:{"type":"position","car_id":15,"lat":-27.123456,"lon":151.654321,"speed_cms":1500,"battery":94,"sat_count":12}
```

## Directory Structure

```
Race Tracker/
├── firmware/
│   ├── gateway/
│   │   ├── src/main.cpp
│   │   ├── include/config.h
│   │   └── platformio.ini
│   ├── tracker/
│   │   ├── src/main.cpp
│   │   ├── include/config.h
│   │   └── platformio.ini
│   └── include/
│       └── tracker.h (shared protocol)
├── server/
│   ├── src/
│   │   ├── index.js (Express + WebSocket)
│   │   ├── db.js (JSON persistence)
│   │   └── tiles.js (Map tiles)
│   ├── public/ (Dashboard UI)
│   ├── scripts/ (Deployment helpers)
│   └── package.json
└── docs/
    ├── OTA_UPDATES.md
    └── USB_GATEWAY_QUICKSTART.md
```

## Configuration Files

### Tracker Config (`firmware/tracker/include/config.h`)
```cpp
#define CAR_ID 15
#define TRACKER_NAME "U15"
#define WIFI_SSID "CORC"
#define WIFI_PASSWORD "LetsRace"
#define GPS_LOG_UPLOAD_URL "http://192.168.0.1:3000/api/tracker-logs"
```

### Gateway Config (`firmware/gateway/include/config.h`)
```cpp
#define UPLINK_TRANSPORT_SERIAL 1
#define SERIAL_GATEWAY_PREFIX "RTJSON:"
#define OTA_ENABLED 1
#define OTA_BOOT_HOLD_MS 3000
```

### Server Config (environment variables)
```bash
SERIAL_GATEWAY_ENABLED=1
SERIAL_GATEWAY_PORT=/dev/serial/by-id/usb-*
SERIAL_GATEWAY_BAUD=115200
SERIAL_GATEWAY_PREFIX=RTJSON:
```

## Troubleshooting

### Tracker stuck in registration loop
**Symptom**: Repeated register attempts, never transitions to operational
**Solution**: Verify gateway is sending ACK packets. Check gateway serial output for `send_sync_packet(car_id, FRAME_REGISTER_ACK)`

### ROM download mode on ESP32
**Symptom**: `waiting for download` message in monitor
**Solution**: Power-cycle device (disconnect USB, wait 5s, reconnect)

### No GPS lock
**Symptom**: Stuck in STATE_GPS_ACQUIRING
**Solution**: 
- Move device outdoors
- Check NEO-6M antenna connection
- Verify TX/RX pins (12=TX, 34=RX)

### Map tiles not loading
**Symptom**: Dashboard shows blank map
**Solution**: 
- Check if `server/data/map.mbtiles` exists (4GB file)
- If missing, server falls back to upstream OpenStreetMap renderer
- Set `USE_UPSTREAM_TILES=1` for online rendering

## Performance

| Metric | Value |
|--------|-------|
| Update Interval | 2 seconds (configurable) |
| LoRa Range | ~5-10 km (line-of-sight, AU915) |
| Tracker Battery Life | ~8-12 hours continuous |
| Gateway Power | ~2W idle, ~4W TX |
| Dashboard Latency | <200ms (WebSocket) |

## API Endpoints

### Position Updates
```
POST /api/position
{ car_id, lat, lon, speed_cms, battery_pct, sat_count }
```

### Alerts
```
POST /api/alert
{ car_id, type, timestamp }
```

### Configuration
```
PUT /api/config/line
{ lat1, lon1, lat2, lon2, line_width }
```

### Car Status
```
GET /api/cars
GET /api/cars/:car_id
```

## Development

### Building Firmware
```bash
# Clean and rebuild tracker
cd firmware/tracker
pio run -e tracker --target clean
pio run -e tracker

# Monitor serial output
pio device monitor -p COM9 -b 115200
```

### Testing Server Locally
```bash
cd server
npm install
node src/index.js
# Open http://localhost:3000
```

### Adding New Features
1. Create feature branch in `Race Tracker V2/` directory
2. Implement changes (firmware/server/dashboard)
3. Test thoroughly on physical devices
4. Document changes and merge to main

## Known Limitations

- Single LoRa gateway (no mesh/relay network)
- Fixed 915.2 MHz AU915 region (change in code for other regions)
- Map tiles require manual download or internet for upstream
- Dashboard is single-user (no multi-user sessions)

## Future Enhancements

- **v3 Features**: Lap timing, scoring, leaderboard
- **Multi-gateway support** for extended range
- **Real-time telemetry** (acceleration, altitude, fuel)
- **Mobile app** for driver feedback
- **Analytics engine** for race replay and analysis

## Dependencies

### Firmware
- RadioLib (LoRa communication)
- TinyGPSPlus (GPS parsing)
- ArduinoJson (JSON serialization)
- Adafruit_NeoPixel (LED control)
- ArduinoOTA (firmware updates)

### Server
- Express.js (REST API)
- ws (WebSocket)
- serialport (USB gateway)
- sqlite3 (MBTiles reader)

## License

[Add your license here]

## Support

For issues, questions, or contributions:
- GitHub: https://github.com/RedMist336/race-tracker
- Documentation: See `docs/` folder

## Changelog

### v2.0 (2026-05-12)
- Initial public release
- GPS tracking via LoRa
- Driver alerts
- Web dashboard
- OTA updates
- Serial gateway bridge

---

**Maintained by**: RedMist336  
**Last Updated**: May 12, 2026
