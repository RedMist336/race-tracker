# Troubleshooting Guide

Comprehensive troubleshooting for Race Tracker v2 hardware, firmware, and server issues.

## Quick Diagnostic Checklist

- [ ] GPS signal acquired (outdoor location)
- [ ] LoRa gateway powered and operational
- [ ] WiFi connectivity confirmed
- [ ] Battery above 20%
- [ ] Serial monitor connected (115200 baud)
- [ ] Dashboard accessible (http://server-ip:3000)

---

## Tracker Issues

### Issue: Tracker stuck in GPS_ACQUIRING state

**Symptoms:**
- Device powers on but never transitions to OPERATIONAL
- Serial monitor shows: `[STATE] STATE_GPS_ACQUIRING`
- LED blinking yellow/green but not blue

**Causes & Solutions:**

1. **No GPS Signal**
   - Move device **outdoors** (15+ meters from buildings)
   - Wait **2-3 minutes** for initial fix
   - Check antenna connection on NEO-6M module
   - Verify antenna is not obstructed
   - Check GPS RX/TX pins: 12 (TX) and 34 (RX)

2. **GPS Module Failure**
   - Check power to NEO-6M (3.3V on VCC pin)
   - Test with different GPS module if available
   - Inspect for cold solder joints

3. **Incorrect Baud Rate**
   - Serial monitor showing garbage for GPS data
   - Verify NEO-6M configured for 9600 baud (default)
   - Some modules default to 4800 or 115200

**Verification:**
```cpp
// In firmware/tracker/src/main.cpp, add debug output:
Serial.print("GPS Lat: "); Serial.println(gps.location.lat(), 6);
Serial.print("GPS Fix Quality: "); Serial.println(gps.hdop.value());
```

---

### Issue: Tracker registers but never enters OPERATIONAL

**Symptoms:**
- Repeated register attempts every 10 seconds
- Serial shows: `[LoRa] Sending FRAME_REGISTER`
- Never receives ACK
- Odroid logs show `[serial] ingested type=register car=15` repeatedly

**Causes & Solutions:**

1. **Gateway Not Sending ACK**
   - Verify gateway is powered and online
   - Check gateway serial output for: `send_sync_packet(car_id, FRAME_REGISTER_ACK)`
   - Confirm gateway firmware includes ACK patch (v2.0+)
   - Monitor gateway with: `pio device monitor -p COM7 -b 115200`

2. **LoRa Radio Frequency Mismatch**
   - Verify both tracker and gateway set to **915.2 MHz**
   - Check regional settings match (AU915)
   - Inspect `config.h` in both:
     ```cpp
     #define LORA_FREQUENCY 915.2e6
     #define LORA_REGION AU915
     ```

3. **LoRa Radio Malfunction**
   - Test with external LoRa analyser if available
   - Check SPI pins (MOSI=27, MISO=19, SCK=5, NSS=18)
   - Inspect for cold solder joints on SX1276

**Recovery:**
```bash
# Reflash gateway with confirmed v2.0 firmware
cd firmware/gateway
pio run -e gateway -t upload --upload-port COM7

# Then power-cycle tracker
```

---

### Issue: LoRa transmission fails ("tx_ok=0")

**Symptoms:**
- Serial shows: `[LoRa] TX Failed: 0` or `[LoRa] Timeout`
- `tx_ok=0` in position updates
- GPS lock achieved but no gateway reception

**Causes & Solutions:**

1. **LoRa Power Amplifier Issue**
   - Check if PA (power amplifier) circuit properly configured
   - Some modules have different PA pins
   - Verify `LORA_TXPOWER` set to valid value (2-20 dBm)

2. **Antenna Connection**
   - Verify SMA/BNC connector tight on SX1276
   - Check antenna is present (should protrude from module)
   - Try different antenna if available

3. **Module Not Initializing**
   - Add debug in firmware:
     ```cpp
     if (!lora.begin()) {
       Serial.println("LoRa init failed - check SPI pins");
       while(1);
     }
     ```

4. **Insufficient Power**
   - LoRa TX draws ~800mA peak
   - Check battery voltage (must be >3.5V)
   - If USB powered, ensure cable supports 1A+ current
   - Battery depleted during high TX load

---

### Issue: Battery reports 0% or false readings

**Symptoms:**
- Dashboard shows battery = 0%
- Battery blinks red immediately after power-on
- Incorrect percentage despite full charge

**Causes & Solutions:**

1. **AXP2101/AXP192 Not Responding**
   - Check I2C pins (SDA=21, SCL=22)
   - Verify pullup resistors present (typically 4.7kΩ)
   - Add debug: `Serial.println(axp.getBattVoltage())`

2. **Battery Not Connected**
   - Check JST connector polarity (red=+, black=-)
   - Verify secure connection
   - Test with known-good battery

3. **ADC Calibration**
   - Some modules require AXP calibration
   - Check datasheet for calibration procedure
   - May need factory reset of AXP chip

---

### Issue: GPS lock takes too long (>10 minutes)

**Symptoms:**
- Stuck in STATE_GPS_ACQUIRING
- Cold start acquisition very slow
- Works in some locations, fails in others

**Causes & Solutions:**

1. **GPS Requires Cold Start**
   - First power-on: 5-15 minutes normal
   - Subsequent power-ons: <2 minutes (with ephemeris)
   - Move device 100m+ from previous location (cold start)

2. **Weak Signal Conditions**
   - **Indoors**: GPS cannot penetrate walls, impossible
   - **Urban canyon**: Tall buildings block satellites
   - **Under trees**: Foliage attenuates signal
   - Solution: Move to open sky, away from obstructions

3. **Antenna Design**
   - NEO-6M requires external antenna for reliable lock
   - Verify antenna SMA connection secure
   - Some antenna pads may be reversed

4. **Ephemeris Data Stale**
   - GPS retains ephemeris for ~4 hours
   - After 4+ hours powered off: cold start again
   - Solution: Power device weekly to refresh data

---

## Gateway Issues

### Issue: Gateway not receiving from tracker

**Symptoms:**
- Tracker sends `[LoRa] TX OK` but gateway shows no `RX OK`
- Serial monitor shows no received packets
- Odroid shows no incoming position data

**Causes & Solutions:**

1. **Distance Too Far**
   - LoRa range: ~5-10 km line-of-sight
   - In urban: 200m-1km typical
   - Obstacles (buildings) reduce range significantly
   - Solution: Move tracker closer to gateway

2. **Antenna Orientation**
   - LoRa antennas are omnidirectional but non-uniform
   - Try rotating antenna on tracker and/or gateway
   - Avoid pointing straight up/down

3. **Frequency Offset**
   - Even 100 kHz offset causes no reception
   - Verify exactly **915.2 MHz** on both
   - Check crystal oscillator accuracy

4. **Spreading Factor Mismatch**
   - Tracker SF7, Gateway SF9 = no RX
   - Must match exactly (default SF7 on both)
   - Check `LORA_SPREADING_FACTOR` in both `config.h`

---

### Issue: Gateway freezes or reboots repeatedly

**Symptoms:**
- Serial output stops abruptly
- Repeated boot loops or watchdog resets
- "Guru Meditation Error" on ESP32 console

**Causes & Solutions:**

1. **Stack Overflow in LoRa Handler**
   - Occurs if LoRa packet received during JSON serialization
   - Solution: Add task mutex protection in main.cpp
   - Check available heap: `Serial.println(esp_get_free_heap_size())`

2. **JSON Buffer Too Small**
   - Large position updates overflow buffer
   - Increase buffer in `main.cpp`:
     ```cpp
     StaticJsonDocument<512> doc;  // Increase if needed
     ```

3. **Insufficient Power**
   - USB power insufficient for WiFi + LoRa + JSON
   - Solution: Use external 5V/2A power supply
   - Check USB cable quality (some are power-limited)

4. **Thermal Stress**
   - If enclosed without ventilation, may throttle/reset
   - Ensure adequate airflow around device
   - Check temperature on chip (may need thermal paste)

---

### Issue: Serial gateway not receiving data

**Symptoms:**
- Gateway powers on, LoRa works
- No data appears in Odroid logs
- Serial monitor shows no TX to USB

**Causes & Solutions:**

1. **USB CDC Driver Not Loaded**
   - Windows: Check Device Manager for "USB Single Serial"
   - Linux: Run `dmesg | grep ttyUSB` after connection
   - If not found, install CH340/CH341 driver

2. **Serial Cable Disconnected**
   - Verify USB cable is fully seated
   - Try different USB cable (some are charge-only)
   - Test on different USB port

3. **Baud Rate Mismatch**
   - Gateway transmits 115200 (fixed)
   - Odroid must listen at 115200
   - Check `/dev/serial/by-id/` permissions

4. **RTJSON Prefix Missing**
   - Odroid filters for "RTJSON:" prefix
   - Verify in `config.h`: `#define SERIAL_GATEWAY_PREFIX "RTJSON:"`
   - Recompile if prefix changed

---

## Server (Odroid) Issues

### Issue: Dashboard not accessible (connection refused)

**Symptoms:**
- Browser shows "connection refused" or "cannot reach"
- `curl http://192.168.0.1:3000` fails
- Server logs show nothing

**Causes & Solutions:**

1. **Node.js Not Running**
   - Check status: `systemctl status race-tracking`
   - Start manually: `cd server && npm install && node src/index.js`
   - Check for errors in startup

2. **Wrong IP Address**
   - Confirm Odroid IP: `hostname -I`
   - Use actual IP, not 192.168.0.1 (example IP)
   - Check if DHCP assigned different IP

3. **Firewall Blocking Port 3000**
   - Test local: `curl localhost:3000`
   - If works locally but not remote: firewall issue
   - Linux: `sudo ufw allow 3000`

4. **Port Already in Use**
   - Check: `netstat -tuln | grep 3000`
   - Kill conflicting process: `sudo lsof -i :3000`
   - Try different port in `server/src/index.js`

---

### Issue: Map tiles not loading (blank map)

**Symptoms:**
- Dashboard loads but map is blank/grey
- Browser console shows 404 errors for tiles

**Causes & Solutions:**

1. **Missing Map Data File**
   - File required: `server/data/map.mbtiles` (4GB)
   - File missing from git (too large to upload)
   - **Solution**: Enable upstream rendering in `.env`:
     ```bash
     USE_UPSTREAM_TILES=1
     ```
   - This falls back to online OpenStreetMap renderer

2. **MBTiles Database Corrupted**
   - Try redownload from original source
   - Or delete and rely on upstream fallback

3. **SQLite3 Not Installed**
   - Check: `npm ls sqlite3`
   - Install: `npm install sqlite3`

---

### Issue: Serial gateway not ingesting data

**Symptoms:**
- Gateway transmits (USB shows data)
- Server starts without errors
- `db.json` never updates with positions

**Causes & Solutions:**

1. **Serial Port Not Detected**
   - Check: `ls /dev/serial/by-id/`
   - Should show device like `usb-1a86_USB_Single_Serial_*`
   - If empty, gateway not detected
   - Solution: Check USB cable, reinstall driver

2. **RTJSON Prefix Not Matching**
   - Gateway sends prefix, server filters for it
   - Check server `src/index.js`:
     ```javascript
     const PREFIX = process.env.SERIAL_GATEWAY_PREFIX || "RTJSON:";
     ```
   - Ensure gateway `config.h` has: `SERIAL_GATEWAY_PREFIX "RTJSON:"`

3. **JSON Parsing Error**
   - Malformed JSON from gateway
   - Enable debug in `src/index.js`:
     ```javascript
     console.log("[DEBUG] Raw:", chunk.toString());
     ```
   - Check format matches expected schema

4. **Permissions Issue**
   - Serial port permission denied
   - Solution: Add user to dialout group:
     ```bash
     sudo usermod -a -G dialout odroid
     ```

---

### Issue: WebSocket not updating (stale position data)

**Symptoms:**
- Dashboard loads, shows old positions
- New positions not broadcast in real-time
- Browser console shows WebSocket errors

**Causes & Solutions:**

1. **WebSocket Not Connected**
   - Browser console: `ws://server-ip:3000` shows failed
   - Check firewall allows WebSocket
   - Verify server listening on correct port

2. **Position Updates Not Triggered**
   - Check `db.json` is updating (use `tail -f`)
   - If not, issue is serial ingestion (see above)
   - If yes, issue is WebSocket broadcast

3. **Broadcast Logic Missing**
   - In `src/index.js`, confirm broadcasts:
     ```javascript
     ws.broadcast(JSON.stringify(position));
     ```
   - Restart server after code changes

---

## Network & Connectivity

### Issue: Tracker cannot connect to WiFi

**Symptoms:**
- Serial shows: `[WiFi] Connecting to CORC...`
- Stuck for 30+ seconds
- Eventually times out

**Causes & Solutions:**

1. **SSID/Password Wrong**
   - Check `config.h` for typos:
     ```cpp
     #define WIFI_SSID "YOUR_NETWORK_NAME"
     #define WIFI_PASSWORD "YOUR_SECURE_PASSWORD"
     ```
   - Spaces matter: "CORC " ≠ "CORC"

2. **WiFi Network Not Available**
   - Verify WiFi router is powered on
   - Check SSID broadcast enabled (not hidden)
   - Confirm channel overlap (use WiFi analyzer)

3. **Too Many Connection Attempts**
   - Device exhausts NVS (non-volatile storage)
   - Solution: Clear NVS:
     ```bash
     pio run -e tracker -t erase_flash
     ```
   - Then reflash firmware

4. **WiFi Shield Interference**
   - Metal case or antenna placement interferes
   - Try removing case during connection
   - Move away from microwave/other 2.4 GHz sources

---

### Issue: Tracker cannot reach server (OTA fails)

**Symptoms:**
- WiFi connects, but OTA upload fails
- Server unreachable from device
- `[WiFi] Cannot connect to server`

**Causes & Solutions:**

1. **Wrong Server IP in Config**
   - Check `config.h`:
     ```cpp
     #define SERVER_IP "192.168.0.1"
     #define SERVER_PORT 3000
     ```
   - Confirm IP matches actual Odroid IP

2. **Server Firewall Blocks Port 3000**
   - Test: `curl http://192.168.0.1:3000`
   - If fails, open port: `sudo ufw allow 3000`

3. **Network Routing Issue**
   - Device and server on different subnets
   - Check both IPs: `hostname -I`
   - Ensure router has route between subnets

4. **DNS Resolution Fails**
   - If using hostname instead of IP:
     ```cpp
     #define SERVER_IP "tracker.local"  // May not work
     ```
   - Solution: Use IP address directly

---

## Performance Issues

### Issue: High latency (positions delayed 10+ seconds)

**Symptoms:**
- Dashboard updates slowly
- Vehicle position lags actual location
- WebSocket shows old timestamps

**Causes & Solutions:**

1. **Low LoRa Signal Quality**
   - Check RSSI (signal strength) in dashboard
   - RSSI > -70 dBm: good
   - RSSI < -90 dBm: poor (retransmissions)
   - Solution: Move gateway closer, improve antenna

2. **Tracker Update Interval Too Long**
   - Default: 2 seconds between updates
   - Increase frequency (lower = more power):
     ```cpp
     #define TRACKER_UPDATE_INTERVAL_MS 1000  // 1 second
     ```

3. **Server Processing Backlog**
   - Check Odroid CPU usage: `top`
   - If >80% CPU, too many concurrent connections
   - Reduce client connection count or optimize JSON parsing

4. **WiFi Congestion**
   - OTA/WiFi updates block LoRa RX briefly
   - Solution: Schedule OTA updates during idle periods
   - Use 5 GHz if available (separate from LoRa 915 MHz)

---

### Issue: Battery drains too quickly

**Symptoms:**
- 100% → 0% in 2-3 hours
- Should last 8-12 hours
- GPS+LoRa operational but excessive power draw

**Causes & Solutions:**

1. **WiFi Always Active**
   - WiFi uses ~50-80 mA
   - Only enable when needed (OTA or logging)
   - Disable in operational mode:
     ```cpp
     WiFi.mode(WIFI_OFF);
     ```

2. **GPS Always Active**
   - NEO-6M draws ~30 mA continuously
   - Disable between updates if not needed
   - Verify `gps.powerSaveMode()` enabled

3. **LoRa TX Power Too High**
   - Transmitting at 20 dBm uses most power
   - Reduce to 10 dBm if range permits:
     ```cpp
     #define LORA_TXPOWER 10
     ```

4. **LED Always On**
   - NeoPixel draws ~10 mA at full brightness
   - Disable or reduce brightness:
     ```cpp
     strip.setBrightness(8);  // was 32
     ```

5. **Deep Sleep Not Working**
   - Verify deep sleep entered between updates
   - Check wakeup timer set correctly:
     ```cpp
     esp_sleep_enable_timer_wakeup(2000000);  // 2 seconds
     ```

---

## Hardware & Physical

### Issue: Device reboots randomly

**Symptoms:**
- Watchdog reset message
- Brownout detector triggered
- "Guru Meditation Error" console output

**Causes & Solutions:**

1. **Insufficient Power Supply**
   - Tablet charger (500mA) insufficient for LoRa TX
   - Use 2A+ USB power supply
   - Or use larger Li-Po battery (3000 mAh+)

2. **USB Cable Issue**
   - Some cables are power-limited (charge-only)
   - Try different quality USB cable
   - Test with direct battery power to isolate

3. **Thermal Stress**
   - Device overheating → brownout reset
   - Check heatsink/thermal paste on ESP32
   - Ensure ventilation around device

4. **Cold Solder Joints**
   - Vibration/thermal cycling causes failures
   - Inspect solder under magnification
   - Reflow if necessary

---

### Issue: Buttons not responding (stuck/unresponsive)

**Symptoms:**
- Boot button doesn't trigger OTA mode
- User button doesn't send alerts
- No serial output for button presses

**Causes & Solutions:**

1. **GPIO Pin Misconfigured**
   - Boot button: GPIO 2 (fixed on ESP32)
   - User button: GPIO configured in `config.h`
   - Verify pins not used by SPI/I2C

2. **Debounce Issues**
   - Try increasing debounce delay:
     ```cpp
     #define BUTTON_DEBOUNCE_MS 50  // was 20
     ```

3. **Pull-up Resistor Missing**
   - Button requires pull-up to 3.3V
   - Check circuit on board
   - Add external 10kΩ if needed

---

## Diagnostic Tools

### Logs & Monitoring

**Serial Monitor (Real-time)**
```bash
pio device monitor -p COM9 -b 115200 -f esp32_exception_decoder
```

**Odroid Systemd Logs**
```bash
sudo journalctl -u race-tracking -f  # Follow live
sudo journalctl -u race-tracking --since "5 min ago"
```

**Browser Console (Dashboard)**
```javascript
// Open DevTools (F12) → Console
// WebSocket debug: 
ws.onmessage = (event) => console.log("WS:", event.data);
```

**Database State**
```bash
cd server && cat db.json | jq '.cars'
```

---

## Support & Escalation

If issue persists after troubleshooting:

1. **Collect Diagnostics**
   - Serial monitor output (full startup + error)
   - `db.json` snapshot
   - Network configuration (IPs, SSID)
   - Hardware revision (TTGo model, GPS module type)

2. **Report Issue**
   - GitHub: https://github.com/RedMist336/race-tracker/issues
   - Include: symptoms, steps to reproduce, diagnostics

3. **Fallback Options**
   - Restart all devices: gateway, server, trackers
   - Reset to factory defaults if available
   - Downgrade firmware to known working version

---

**Last Updated**: May 12, 2026  
**See Also**: [README.md](README.md), [OTA_UPDATES.md](OTA_UPDATES.md)
