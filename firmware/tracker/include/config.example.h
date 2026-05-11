// Race Tracking — Tracker Node Configuration
// Hardware: TTGO TBeam v1.2
//
// Copy this file to config.h and edit before flashing.
// config.h is NOT committed to version control.

// =============================================================================
//  DEVICE IDENTIFICATION
// =============================================================================

// Unique car number. Valid range 1–254.  0 and 255 are reserved.
#define CAR_ID 1

// Human-readable label (used in GPS log uploads).
#define TRACKER_NAME "Tracker-1"

// =============================================================================
//  LORA RF PARAMETERS  (must match gateway exactly)
// =============================================================================

#define LORA_FREQUENCY        915.2f   // MHz  — AU915 default
#define LORA_BANDWIDTH        125.0f   // kHz  — 125, 250, or 500
#define LORA_SPREADING_FACTOR 7        // 7–12 (higher = longer range)
#define LORA_CODING_RATE      5        // 4/5 … 4/8
#define LORA_TX_POWER         20       // dBm  — legal max AU915: 20 dBm
#define LORA_SYNC_WORD        0x34     // private network
#define LORA_CRC_ENABLED      true
#define LORA_PREAMBLE_LEN     8
#define LORA_REGION_AU915              // controls modem post-init settings

// =============================================================================
//  GPS  (TTGO TBeam v1.2 — UART1)
// =============================================================================

#define GPS_RX_PIN  34   // v1.2 uses GPIO 34  (v1.1 used 15)
#define GPS_TX_PIN  12
#define GPS_BAUD    9600

// =============================================================================
//  TIMING
// =============================================================================

#define GPS_UPDATE_INTERVAL_MS    2000   // ms between position transmissions
#define REGISTER_RETRY_INTERVAL_MS 10000 // ms between REGISTER retries

// =============================================================================
//  BUTTON  (TTGO TBeam main button)
// =============================================================================

#define BUTTON_PIN            2
#define BUTTON_ALERT_HOLD_MS  2000    // hold to send driver alert
#define GPS_LOG_UPLOAD_HOLD_MS 20000  // hold to trigger WiFi log upload
#define BUTTON_DEBOUNCE_MS    20

// =============================================================================
//  LOCAL GPS LOGGING + WIFI UPLOAD
// =============================================================================

#define GPS_LOG_WRITE_INTERVAL_MS 10000   // flush to flash every N ms

#define WIFI_SSID               ""
#define WIFI_PASSWORD           ""
#define GPS_LOG_UPLOAD_URL      "http://192.168.0.1:3000/api/tracker-logs"
#define WIFI_CONNECT_TIMEOUT_MS 15000

// OTA maintenance mode (hold alert button during boot)
#define OTA_ENABLED                 1
#define OTA_BOOT_HOLD_MS            3000
#define OTA_WIFI_CONNECT_TIMEOUT_MS 15000
#define OTA_HOSTNAME_PREFIX         "race-tracker"
#define OTA_PASSWORD                ""

// Optional battery ADC tuning (defaults in tracker.h are suitable for T-Beam v1.2)
// #define BATTERY_ADC_PIN               35
// #define BATTERY_ADC_VREF_V            3.3f
// #define BATTERY_ADC_DIVIDER_RATIO     2.0f
// #define BATTERY_CALIBRATION_MULTIPLIER 1.0f
// #define BATTERY_EMPTY_V               3.30f
// #define BATTERY_FULL_V                4.20f

// =============================================================================
//  STATUS LED  (NeoPixel — TTGO TBeam v1.2 = GPIO 4)
// =============================================================================

#define NEOPIXEL_PIN   4
#define NEOPIXEL_COUNT 1

// =============================================================================
//  5×5 NeoPixel RGB status matrix  (data IN wired to GPIO 15)
// =============================================================================

#define MATRIX_PIN              15
#define MATRIX_BRIGHTNESS       32    // 0-255; 32 ≈ 12 % — avoids eye strain / power draw
#define MATRIX_BLINK_PERIOD_MS  2000  // full on+off cycle length in ms
#define MATRIX_SERPENTINE       1     // 1 = every other row reversed (serpentine wiring), 0 = row-major

// =============================================================================
//  HARDWARE SPI  (SX1276 — TTGO TBeam)
// =============================================================================

#define LORA_SPI_MOSI 27
#define LORA_SPI_MISO 19
#define LORA_SPI_SCK   5
#define LORA_NSS      18
#define LORA_RST      23
#define LORA_DIO0     26
#define LORA_DIO1     33

// =============================================================================
//  SERIAL / DIAGNOSTICS
// =============================================================================

#define SERIAL_BAUD         115200
#define DIAGNOSTICS_ENABLED 1
