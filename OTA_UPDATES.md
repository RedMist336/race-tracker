# OTA Firmware Updates Guide

## Overview

Race Tracker supports Over-The-Air (OTA) firmware updates for both gateway and tracker devices using Arduino OTA protocol. This eliminates the need for USB cable connections to update firmware.

## Requirements

- **WiFi Network**: Device must be able to connect to WiFi (configured in `config.h`)
- **Network Connectivity**: Host PC and device must be on the same network
- **Python**: Required for Arduino OTA protocol
- **PlatformIO**: CLI or VS Code extension

## Configuration

### WiFi Credentials

Edit the appropriate config file with YOUR network credentials:

#### Tracker (`firmware/tracker/include/config.h`)
```cpp
#define WIFI_SSID "YOUR_NETWORK_NAME"
#define WIFI_PASSWORD "YOUR_SECURE_PASSWORD"
```

#### Gateway (`firmware/gateway/include/config.h`)
```cpp
#define WIFI_SSID "YOUR_NETWORK_NAME"
#define WIFI_PASSWORD "YOUR_SECURE_PASSWORD"
```

### OTA Settings

Both devices have configurable OTA parameters:

```cpp
#define OTA_ENABLED 1                  // Enable/disable OTA feature
#define OTA_BOOT_HOLD_MS 3000         // Button hold duration for OTA mode (ms)
#define OTA_PORT 3232                 // Arduino OTA default port
#define OTA_PASSWORD ""               // Optional OTA password (empty = no auth)
```

## Entering OTA Mode

### Method 1: Boot Button (Recommended)

1. **Power-off** the device (disconnect USB)
2. **Press and hold** boot button (GPIO 2)
3. **Power-on** (connect USB or battery)
4. **Hold button** for **3 seconds** while powered
5. Device enters **OTA maintenance mode**

**Visual Feedback:**
- Red LED blinks 5 times → Ready for OTA
- Serial monitor shows: `[OTA] Maintenance mode active, waiting for updates...`

### Method 2: Serial Command (Alternative)

Connect via serial and send special command:
```
!OTA_MODE
```

Device restarts in OTA mode within 2 seconds.

### Method 3: Timeout Auto-Recovery

If device hangs or becomes unresponsive:
1. Hold boot button during power-on for 5+ seconds
2. Device ignores race loop and waits for OTA update
3. After 60 seconds with no update received, device soft-resets

## Uploading Firmware via OTA

### Step 1: Identify Device IP Address

Find device IP on your network. Options:

**Option A: From Serial Monitor**
```
[WiFi] Connected to CORC
[WiFi] IP Address: 192.168.68.45
[OTA] Ready for update at: 192.168.68.45:3232
```

**Option B: Router Interface**
Look for device hostname (e.g., "esp32-tracker-15" or "esp32-gateway")

**Option C: Network Scan**
```bash
arp -a | findstr esp32
# or use IP scanner app
```

### Step 2: Build Firmware for OTA

```bash
# For Tracker
cd firmware/tracker
pio run -e tracker_ota

# For Gateway
cd firmware/gateway
pio run -e gateway_ota
```

This produces a compressed binary ready for OTA deployment.

### Step 3: Upload via PlatformIO CLI

#### Tracker
```bash
cd firmware/tracker
pio run -e tracker_ota -t upload --upload-port 192.168.68.45
```

#### Gateway
```bash
cd firmware/gateway
pio run -e gateway_ota -t upload --upload-port 192.168.68.45
```

Replace `192.168.68.45` with your device's actual IP address.

### Step 4: Monitor Upload Progress

PlatformIO will show real-time progress:
```
Sending invitation to [192.168.68.45]
IP: 192.168.68.45:3232
Connected. Uploading...
Progress: 25%
Progress: 50%
Progress: 75%
Progress: 100%
MD5 Sum: 5a8c3d9e2f1b4c6a7...
Verifying...
Update complete.
Device restarting...
```

### Step 5: Verify Update

Device will restart automatically. Confirm:

**Via Serial Monitor:**
```
[OTA] Update received and verified
[OTA] Restarting...
[System] Boot reason: 1
[Config] Version: 2.0.1
```

**Via Dashboard:**
- Tracker re-appears on map
- Gateway status returns to operational

## Common OTA Issues

### "Address already in use"
**Cause**: Previous OTA upload still in progress or port conflict
**Solution**:
```bash
# Wait 30 seconds and retry, or:
pio run -e tracker_ota -t upload --upload-port 192.168.68.45 --skip-default-monitor
```

### "No address associated with hostname"
**Cause**: Device IP unknown or network unreachable
**Solution**:
1. Verify device is powered and connected to WiFi
2. Check WiFi SSID and password in config
3. Ensure device and PC are on same network
4. Use serial monitor to find actual IP address

### "Connection refused"
**Cause**: Device not in OTA mode or OTA port not listening
**Solution**:
1. Power-cycle device with boot button held for 3 seconds
2. Verify serial monitor shows OTA ready message
3. Try again within 60 seconds (timeout window)

### "Update checksum mismatch"
**Cause**: Corrupted upload or network interruption
**Solution**:
1. Move device closer to WiFi router
2. Retry upload (automatic resume supported)
3. If persistent, try `--skip-default-monitor` flag

### "Device disconnected during upload"
**Cause**: WiFi signal lost or device became unreachable
**Solution**:
1. Ensure strong WiFi signal (use `pio` to check RSSI)
2. Reduce distance from router
3. Stop other bandwidth-heavy activities
4. Retry upload

## Password-Protected OTA

For enhanced security, set OTA password in config:

```cpp
#define OTA_PASSWORD "my_secure_password_123"
```

Then upload requires password:
```bash
pio run -e tracker_ota -t upload --upload-port 192.168.68.45 --ota-password=my_secure_password_123
```

## Advanced: Manual OTA via Python

If PlatformIO CLI unavailable, use Arduino OTA protocol directly:

```bash
pip install espota

espota.py -i 192.168.68.45 -p 3232 -f firmware/tracker/.pio/build/tracker_ota/firmware.bin
```

## Best Practices

### Before OTA Update
1. ✅ **Backup current firmware** (save `.bin` file locally)
2. ✅ **Test on secondary device** if possible
3. ✅ **Ensure strong WiFi signal** (monitor RSSI > -70 dBm)
4. ✅ **Full battery** on tracker (> 80% recommended)
5. ✅ **No active race/logging** in progress

### During OTA Update
1. ✅ **Keep device powered** (do not disconnect USB/battery)
2. ✅ **Do not move device** far from router
3. ✅ **Monitor upload progress** in terminal
4. ✅ **Wait for restart** confirmation message

### After OTA Update
1. ✅ **Verify new version** via serial monitor
2. ✅ **Test basic functions** (GPS, LoRa, LED)
3. ✅ **Check logs** for any errors
4. ✅ **Monitor battery drain** (first 5 minutes)

## Rollback Procedure

If new firmware causes issues:

### Option 1: Revert via OTA (If Device Still Bootable)
1. Find previous firmware `.bin` in `.pio/build/tracker/` or `.pio/build/gateway/`
2. Enter OTA mode on device
3. Upload previous `.bin`:
   ```bash
   espota.py -i 192.168.68.45 -p 3232 -f previous_firmware.bin
   ```

### Option 2: USB Cable Recovery (If OTA Fails)
1. Connect device via USB to PC
2. Flash stable firmware via serial:
   ```bash
   pio run -e tracker -t upload --upload-port COM9
   ```

## OTA Architecture Details

### Firmware Structure
```
.pio/build/tracker_ota/
├── firmware.bin         (compressed binary, ~500KB)
├── firmware.elf         (debug symbols)
└── firmware.map         (memory layout)
```

### OTA Process Flow
```
1. Device boots in OTA mode
   ├─ WiFi connects
   ├─ OTA service listens on port 3232
   └─ Awaits upload (60s timeout)

2. PC sends firmware via OTA protocol
   ├─ Binary streamed in chunks
   ├─ Checksum verified per chunk
   └─ MD5 verified on completion

3. Device validates firmware
   ├─ Signature check (if enabled)
   ├─ Partition check
   └─ CRC validation

4. Device writes to flash partition
   ├─ Secondary OTA partition used
   ├─ Original firmware preserved until success
   └─ Rollback possible if new fails

5. Device reboots with new firmware
   ├─ Bootloader verifies new partition
   ├─ If valid, marks as active
   └─ If invalid, reverts to previous
```

## Troubleshooting Checklist

- [ ] Device powered (USB or battery)
- [ ] WiFi connected (check serial output)
- [ ] IP address known/accessible
- [ ] Port 3232 open/available
- [ ] Boot button held during power-on
- [ ] OTA mode confirmed (LED blinks, serial shows ready)
- [ ] Firmware binary compiled (`pio run -e tracker_ota`)
- [ ] Network connectivity stable (ping device)
- [ ] No firewall blocking port 3232
- [ ] PlatformIO updated (`pio upgrade`)

## Limits & Specifications

| Parameter | Value |
|-----------|-------|
| Max Firmware Size | 1.8 MB |
| Typical Update Time | 30-60 seconds |
| OTA Mode Timeout | 60 seconds (auto-reboot) |
| WiFi Required | Yes |
| Battery Required | Recommended (>80%) |
| Simultaneous Updates | 1 device at a time |

## Security Considerations

- OTA updates transmitted **unencrypted** over WiFi
- Optional password protection available (see above)
- Only update from **trusted networks**
- Keep WiFi password strong to prevent unauthorized updates
- Consider WPA2/WPA3 for WiFi security

## See Also

- [README.md](README.md) - General project documentation
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - General troubleshooting guide
- [firmware/tracker/platformio.ini](firmware/tracker/platformio.ini) - Build configuration

---

**Last Updated**: May 12, 2026  
**Tested On**: ESP32 TTGo T-Beam v1.2, PlatformIO 6.1+
