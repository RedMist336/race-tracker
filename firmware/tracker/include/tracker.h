// Race Tracking — Car Tracker Node
// Hardware: TTGO TBeam v1.2 (ESP32 + SX1276 + NEO-6M GPS + NeoPixel)
// Sends GPS + speed via LoRa, detects button alerts, receives gateway sync.
//
// Per-device settings live in config.h — copy config.example.h → config.h
// and set CAR_ID before flashing each tracker.

#ifndef TRACKER_H
#define TRACKER_H

#include <Arduino.h>

#define FIRMWARE_VERSION "3.0.0"

#ifndef TRACKER_NAME
#define TRACKER_NAME "Tracker"
#endif

#ifndef CAR_CLASS
#define CAR_CLASS 'U'
#endif

#ifndef GPS_LOG_WRITE_INTERVAL_MS
#define GPS_LOG_WRITE_INTERVAL_MS 10000
#endif

#ifndef GPS_LOG_UPLOAD_HOLD_MS
#define GPS_LOG_UPLOAD_HOLD_MS 20000
#endif

#ifndef GPS_LOG_UPLOAD_URL
#define GPS_LOG_UPLOAD_URL ""
#endif

#ifndef GPS_LOG_STORAGE_ENABLED
#define GPS_LOG_STORAGE_ENABLED 0
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef WIFI_CONNECT_TIMEOUT_MS
#define WIFI_CONNECT_TIMEOUT_MS 15000
#endif

#ifndef OTA_ENABLED
#define OTA_ENABLED 1
#endif

#ifndef OTA_BOOT_HOLD_MS
#define OTA_BOOT_HOLD_MS 3000
#endif

#ifndef OTA_WIFI_CONNECT_TIMEOUT_MS
#define OTA_WIFI_CONNECT_TIMEOUT_MS 15000
#endif

#ifndef OTA_HOSTNAME_PREFIX
#define OTA_HOSTNAME_PREFIX "race-tracker"
#endif

#ifndef OTA_PASSWORD
#define OTA_PASSWORD ""
#endif

#ifndef BATTERY_ADC_PIN
#define BATTERY_ADC_PIN 35
#endif

#ifndef BATTERY_USE_AXP192
#define BATTERY_USE_AXP192 1
#endif

#ifndef BATTERY_USE_AXP2101
#define BATTERY_USE_AXP2101 1
#endif

#ifndef BATTERY_AXP192_ADDR
#define BATTERY_AXP192_ADDR 0x34
#endif

#ifndef BATTERY_AXP2101_ADDR
#define BATTERY_AXP2101_ADDR 0x34
#endif

#ifndef BATTERY_I2C_SDA
#define BATTERY_I2C_SDA 21
#endif

#ifndef BATTERY_I2C_SCL
#define BATTERY_I2C_SCL 22
#endif

#ifndef BATTERY_ADC_VREF_V
#define BATTERY_ADC_VREF_V 3.3f
#endif

#ifndef BATTERY_ADC_DIVIDER_RATIO
#define BATTERY_ADC_DIVIDER_RATIO 2.0f
#endif

#ifndef BATTERY_CALIBRATION_MULTIPLIER
#define BATTERY_CALIBRATION_MULTIPLIER 1.0f
#endif

#ifndef BATTERY_EMPTY_V
#define BATTERY_EMPTY_V 3.30f
#endif

#ifndef BATTERY_FULL_V
#define BATTERY_FULL_V 4.20f
#endif

// =============================================================================
//  Packet frame types  (tracker ↔ gateway)
// =============================================================================

enum FrameType : uint8_t {
    FRAME_GPS_UPDATE   = 0x01,  // Tracker → Gateway: periodic position
    FRAME_ALERT        = 0x02,  // Tracker → Gateway: driver alert
    FRAME_LAP_CROSSING = 0x03,  // Tracker → Gateway: start/stop crossing
    FRAME_SYNC         = 0x04,  // Gateway → Tracker: time + line config broadcast
    FRAME_REGISTER     = 0x05,  // Tracker → Gateway: initial registration
    FRAME_REGISTER_ACK = 0x06,  // Gateway → Tracker: registration confirmed
    FRAME_ALERT_CONTROL = 0x07  // Gateway → Tracker: latch/clear alert mode
};

enum AlertType : uint8_t {
    ALERT_BRAKE_FAILURE   = 0x01,
    ALERT_MECHANICAL      = 0x02,
    ALERT_DRIVER_REQUEST  = 0x03
};

// =============================================================================
//  Data structures
// =============================================================================

struct GPSData {
    int32_t  latitude;   // degrees × 1e7
    int32_t  longitude;  // degrees × 1e7
    uint16_t speed_cms;  // cm/s
    uint8_t  accuracy;   // HDOP × 10, clamped to 255
    uint8_t  sat_count;
    uint32_t timestamp;  // server-synced UNIX seconds
};

struct StartStopLine {
    int32_t  lat1, lon1;        // degrees × 1e7
    int32_t  lat2, lon2;        // degrees × 1e7
    uint16_t width_m;
    uint32_t config_version;
    bool     is_configured;
};

enum TrackerState : uint8_t {
    STATE_INIT         = 0,
    STATE_GPS_ACQUIRING,
    STATE_OPERATIONAL,
    STATE_ERROR,
    STATE_REGISTERING  // GPS fix obtained; REGISTER sent; awaiting ACK
};

// =============================================================================
//  LoRa packet layouts  (packed, no padding)
// =============================================================================

struct __attribute__((packed)) LoRaPacketHeader {
    uint8_t  frame_type;
    uint8_t  car_id;
    uint32_t timestamp;
};

struct __attribute__((packed)) LoRaGPSUpdate {
    LoRaPacketHeader header;   // frame_type = FRAME_GPS_UPDATE
    int32_t  lat;
    int32_t  lon;
    uint16_t speed_cms;
    uint8_t  battery_pct; // 0-100
    uint8_t  sat_count;
    uint8_t  checksum;
    // Total: 19 bytes
};

struct __attribute__((packed)) LoRaAlert {
    LoRaPacketHeader header;   // frame_type = FRAME_ALERT
    int32_t lat;
    int32_t lon;
    uint8_t alert_type;
    uint8_t checksum;
    // Total: 16 bytes
};

struct __attribute__((packed)) LoRaLapCrossing {
    LoRaPacketHeader header;   // frame_type = FRAME_LAP_CROSSING
    int32_t  lat;
    int32_t  lon;
    uint8_t  crossing_type;    // 0x01 = start, 0x02 = finish
    uint16_t lap_number;
    uint8_t  checksum;
    // Total: 18 bytes
};

struct __attribute__((packed)) LoRaSyncPacket {
    uint8_t  frame_type;       // FRAME_SYNC or FRAME_REGISTER_ACK
    uint8_t  car_id;           // 0xFF = broadcast
    uint32_t server_timestamp;
    uint16_t config_version;
    int32_t  line_lat1;
    int32_t  line_lon1;
    int32_t  line_lat2;
    int32_t  line_lon2;
    uint16_t line_width_m;
    uint8_t  checksum;
    // Total: 27 bytes
};

struct __attribute__((packed)) LoRaRegister {
    uint8_t  frame_type;       // FRAME_REGISTER
    uint8_t  car_id;
    uint32_t timestamp;
    int32_t  lat;
    int32_t  lon;
    uint8_t  class_code;       // ORANZ class prefix: C/U/M/J/S
    uint8_t  checksum;
    // Total: 16 bytes
};

#endif // TRACKER_H
