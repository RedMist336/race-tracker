// Race Tracking — Tracker Node Firmware
// Hardware: TTGO TBeam v1.2  (ESP32 + SX1276 LoRa + NEO-6M GPS + NeoPixel)
//
// Flow:
//   Boot → GPS acquiring → send FRAME_REGISTER via LoRa →
//   await FRAME_REGISTER_ACK from gateway → STATE_OPERATIONAL →
//   periodic FRAME_GPS_UPDATE every GPS_UPDATE_INTERVAL_MS

#include <Arduino.h>
#include "config.h"
#include "tracker.h"

#include <TinyGPS++.h>
#include <HardwareSerial.h>
#include <RadioLib.h>
#include <Adafruit_NeoPixel.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <Wire.h>
#include <time.h>
#include <math.h>
#include <stdio.h>

// =============================================================================
//  Global objects
// =============================================================================

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);  // UART1

SPIClass spi;
SX1276 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST, LORA_DIO1, spi);

Adafruit_NeoPixel pixel(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel matrix_leds(25, MATRIX_PIN, NEO_GRB + NEO_KHZ800);

// =============================================================================
//  5×5 matrix — digit bitmaps
//  Each row is 5 bits: bit4=col0 (left) … bit0=col4 (right).  Row 0 = top.
// =============================================================================

static const uint8_t DIGIT_BITMAP[10][5] = {
    { 0x0E, 0x11, 0x11, 0x11, 0x0E },  // 0: .###. | #...# | #...# | #...# | .###.
    { 0x04, 0x0C, 0x04, 0x04, 0x0E },  // 1: ..#.. | .##.. | ..#.. | ..#.. | .###.
    { 0x0E, 0x01, 0x0E, 0x10, 0x1F },  // 2: .###. | ....# | .###. | #.... | #####
    { 0x0E, 0x01, 0x06, 0x01, 0x0E },  // 3: .###. | ....# | ..##. | ....# | .###.
    { 0x11, 0x11, 0x1F, 0x01, 0x01 },  // 4: #...# | #...# | ##### | ....# | ....#
    { 0x1F, 0x10, 0x1E, 0x01, 0x1E },  // 5: ##### | #.... | ####. | ....# | ####.
    { 0x0E, 0x10, 0x1E, 0x11, 0x0E },  // 6: .###. | #.... | ####. | #...# | .###.
    { 0x1F, 0x01, 0x02, 0x04, 0x04 },  // 7: ##### | ....# | ...#. | ..#.. | ..#..
    { 0x0E, 0x11, 0x0E, 0x11, 0x0E },  // 8: .###. | #...# | .###. | #...# | .###.
    { 0x0E, 0x11, 0x0E, 0x01, 0x0E },  // 9: .###. | #...# | .###. | ....# | .###.
};

// =============================================================================
//  Constants
// =============================================================================

static const char*   GPS_LOG_DIR          = "/gps";
static const char*   GPS_LOG_HEADER       = "timestamp,device_ms,latitude,longitude,speed_cms,accuracy,sat_count\n";
static const size_t  GPS_LOG_BUFFER_BYTES = 2048;
static const size_t  GPS_LOG_RAM_MAX_BYTES = 96 * 1024;
static const uint32_t GPS_LOG_MAX_AGE_SECONDS = 183UL * 24UL * 60UL * 60UL;

static const uint8_t PACKET_GPS_UPDATE_LEN  = 19;
static const uint8_t PACKET_ALERT_LEN       = 16;
static const uint8_t PACKET_LAP_LEN         = 18;
static const uint8_t PACKET_SYNC_LEN        = 27;
static const uint8_t PACKET_REGISTER_LEN    = 16;
static const uint8_t PACKET_ALERT_CONTROL_LEN = 8;

// =============================================================================
//  State variables
// =============================================================================

GPSData      current_gps       = {};
StartStopLine start_stop_line  = {};
TrackerState current_state     = STATE_INIT;

uint32_t last_gps_update_ms   = 0;
uint32_t server_time_offset   = 0;
uint32_t last_sync_time       = 0;
bool     sync_received        = false;
bool     gps_lock_announced   = false;
bool     gps_lock_valid       = false;

uint32_t last_register_ms     = 0;
bool     registered           = false;

uint32_t button_press_start   = 0;
bool     button_was_pressed   = false;
uint32_t button_last_change_ms = 0;
bool     button_raw_state      = false;
bool     button_alert_sent     = false;
bool     button_long_hold_armed = false;
bool     alert_latched         = false;

uint16_t current_lap          = 0;
uint32_t lap_start_time       = 0;

String   pending_log_buffer;
String   current_log_file_path;
uint32_t last_log_flush_ms    = 0;
bool     storage_ready        = false;
bool     old_log_cleanup_done = false;

uint32_t packets_sent         = 0;
uint32_t lora_errors          = 0;
volatile bool lora_rx_flag    = false;
volatile bool lora_listening  = false;
uint32_t effective_gps_interval_ms = GPS_UPDATE_INTERVAL_MS;

uint32_t rx_packets_ok        = 0;
uint32_t rx_crc_fail          = 0;
uint32_t rx_header_fail       = 0;
uint32_t rx_other_errors      = 0;
uint32_t tx_packets_ok        = 0;
uint32_t tx_packets_err       = 0;
uint32_t sync_packets_applied = 0;
uint32_t last_diag_report_ms  = 0;

uint8_t  battery_percent       = 0;
float    battery_voltage_v     = 0.0f;
uint32_t last_battery_sample_ms = 0;
bool     ota_mode_active       = false;
char     ota_hostname[48]      = {0};

// =============================================================================
//  Forward declarations
// =============================================================================

void init_gps();
void init_lora();
void init_neopixel();
void init_storage();

void update_gps();
void send_gps_update();
void send_register();
void send_driver_alert();
void check_button_alert();

void log_current_gps_sample(uint32_t now_ms);
bool flush_log_buffer(bool force);
bool ensure_log_file_header_for_path(const String& file_path);
bool upload_logs_via_wifi();
bool connect_wifi_for_upload();
void disconnect_wifi_after_upload();
bool should_enter_ota_mode_on_boot();
bool start_ota_mode();
void handle_ota_mode_loop(uint32_t now_ms);
String build_log_date_label(uint32_t unix_time);
String active_gps_log_file_path();
bool cleanup_old_log_files(uint32_t now_unix);
bool is_plausible_unix_time(uint32_t unix_time);
bool upload_single_log_file(const String& file_path);
bool upload_pending_log_buffer();
bool extract_log_date_from_filename(const String& file_path, String& out_date);
String sanitize_filename_component(const String& input);
String normalize_log_path(const String& entry_name);

void apply_sync(uint8_t* data, uint8_t len);
void apply_alert_control(uint8_t* data, uint8_t len);
void process_lora_packet(uint8_t* data, uint8_t len);

bool    calculate_line_crossing(GPSData prev, GPSData curr, StartStopLine line, uint8_t& crossing_type);
float   distance_to_line(float lat, float lon, StartStopLine line);
uint8_t calculate_checksum(uint8_t* data, uint8_t len);
void    send_lora_packet(uint8_t* packet, uint8_t len);
void    enter_lora_receive_mode();
float   compute_lora_airtime_ms(uint8_t payload_len);
uint32_t compute_budgeted_interval_ms(uint8_t payload_len, uint16_t node_count);
void    log_diagnostics(uint32_t now_ms);

void set_led_status(uint32_t color);
void blink_led(uint32_t color, uint16_t ms);
void debug_log(const char* msg);

void init_matrix();
void update_matrix_display(uint32_t now_ms);
void show_upload_hold_feedback();
void init_battery_monitor();
void update_battery_status(uint32_t now_ms);
float read_battery_voltage_v();
uint8_t battery_percent_from_voltage(float voltage_v);
bool axp192_read_u8(uint8_t reg, uint8_t& out);
bool axp192_write_u8(uint8_t reg, uint8_t value);
float read_battery_voltage_axp192_v();
bool read_battery_percent_axp192(uint8_t& out_pct);
bool read_battery_percent_axp2101(uint8_t& out_pct);
float read_battery_voltage_axp2101_v();
uint8_t tracker_display_digit();

#if defined(ESP32)
void IRAM_ATTR on_lora_rx_done() {
    if (lora_listening) lora_rx_flag = true;
}
#else
void on_lora_rx_done() {
    if (lora_listening) lora_rx_flag = true;
}
#endif

// =============================================================================
//  setup / loop
// =============================================================================

void setup() {
    Serial.begin(SERIAL_BAUD);
    delay(1000);

    Serial.printf("\n\n=== Race Tracking — Tracker Node Booting ===\n");
    Serial.printf("Firmware: %s  Car ID: %d\n", FIRMWARE_VERSION, CAR_ID);

    init_neopixel();
    init_matrix();
    set_led_status(0x0000FF);  // Blue = initialising
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    if (OTA_ENABLED && should_enter_ota_mode_on_boot()) {
        if (start_ota_mode()) {
            Serial.println("[TRACKER] OTA mode active; race functions paused until reboot");
            return;
        }
        Serial.println("[TRACKER] OTA mode requested but WiFi unavailable; continuing normal boot");
    }

#if GPS_LOG_STORAGE_ENABLED
    init_storage();
#else
    storage_ready = false;
    Serial.println("[TRACKER] GPS log storage disabled (GPS_LOG_STORAGE_ENABLED=0)");
#endif
    init_gps();
    init_lora();
    init_battery_monitor();

    // Apply link-budgeted cadence so multi-car operation stays within channel budget.
    effective_gps_interval_ms = compute_budgeted_interval_ms(PACKET_GPS_UPDATE_LEN, LINK_BUDGET_EXPECTED_NODES);
    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] GPS interval: base=%lu ms effective=%lu ms nodes=%u util=%u/1000 x%u\n",
                      (unsigned long)GPS_UPDATE_INTERVAL_MS,
                      (unsigned long)effective_gps_interval_ms,
                      (unsigned)LINK_BUDGET_EXPECTED_NODES,
                      (unsigned)LINK_BUDGET_TARGET_CHANNEL_UTIL_PERMILLE,
                      (unsigned)LINK_BUDGET_INTERVAL_MULTIPLIER);
    }

    current_state = STATE_REGISTERING;
    Serial.println("Setup complete. Awaiting gateway registration ACK.");
}

void loop() {
    uint32_t now_ms = millis();

    if (ota_mode_active) {
        handle_ota_mode_loop(now_ms);
        return;
    }

    update_gps();
    update_battery_status(now_ms);
    check_button_alert();
    log_diagnostics(now_ms);

    // Registration — retry until ACK received
    if (!registered &&
        (current_state == STATE_REGISTERING || current_state == STATE_GPS_ACQUIRING)) {
        if (now_ms - last_register_ms >= REGISTER_RETRY_INTERVAL_MS) {
            send_register();
            last_register_ms = now_ms;
        }
    }

    // Periodic GPS update — always while operational so no-GPS state is reported upstream.
    if (sync_received && current_state == STATE_OPERATIONAL) {
        if (now_ms - last_gps_update_ms >= effective_gps_interval_ms) {
            send_gps_update();
            last_gps_update_ms = now_ms;
        }
    }

    // LoRa receive
    if (lora_rx_flag) {
        lora_rx_flag = false;
        uint8_t  buf[256];
        size_t   pkt_len = radio.getPacketLength();
        if (pkt_len > sizeof(buf)) pkt_len = sizeof(buf);

        int state = radio.readData(buf, pkt_len);
        if (state == RADIOLIB_ERR_NONE) {
            rx_packets_ok++;
            process_lora_packet(buf, (uint8_t)pkt_len);
        } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
            rx_crc_fail++;
            if (DIAGNOSTICS_ENABLED) Serial.println("[TRACKER] RX CRC mismatch");
        } else if (state == RADIOLIB_ERR_LORA_HEADER_DAMAGED) {
            rx_header_fail++;
            if (DIAGNOSTICS_ENABLED) Serial.println("[TRACKER] RX header damaged");
        } else if (DIAGNOSTICS_ENABLED) {
            rx_other_errors++;
            Serial.printf("[TRACKER] RX error %d\n", state);
        } else {
            rx_other_errors++;
        }
        enter_lora_receive_mode();
    }

    // LED status (single onboard pixel — kept for backward compatibility)
    if (current_state == STATE_OPERATIONAL && sync_received) {
        set_led_status(((now_ms / 500) % 3 == 0) ? 0x00FF00 : 0x000000);
    } else if (current_state == STATE_REGISTERING) {
        set_led_status(((now_ms / 300) % 2 == 0) ? 0x0000FF : 0x000000);
    } else if (current_state == STATE_GPS_ACQUIRING) {
        set_led_status(0xFFFF00);
    } else {
        set_led_status(0xFF0000);
    }

    // 5×5 matrix status display
    update_matrix_display(now_ms);
}

// =============================================================================
//  Initialisation
// =============================================================================

void init_gps() {
    gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    Serial.printf("[TRACKER] GPS UART started (RX=%d TX=%d @ %d baud)\n",
                  GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD);
}

void init_storage() {
    bool mount_ok = LittleFS.begin(false, "/littlefs", 10, "littlefs");
    Serial.printf("[TRACKER] LittleFS mount(no-format): %s\n", mount_ok ? "OK" : "FAIL");
    if (!mount_ok) {
        Serial.println("[TRACKER] LittleFS formatting...");
        mount_ok = LittleFS.begin(true, "/littlefs", 10, "littlefs");
        Serial.printf("[TRACKER] LittleFS mount(after-format): %s\n", mount_ok ? "OK" : "FAIL");
    }
    storage_ready = mount_ok;
    if (!storage_ready) {
        Serial.println("[TRACKER] LittleFS init failed — GPS logging disabled");
        return;
    }

    if (!LittleFS.exists(GPS_LOG_DIR)) {
        if (!LittleFS.mkdir(GPS_LOG_DIR)) {
            Serial.println("[TRACKER] Failed to create /gps directory");
        }
    }

    current_log_file_path = active_gps_log_file_path();
    ensure_log_file_header_for_path(current_log_file_path);
    last_log_flush_ms = millis();
}

void init_lora() {
    spi.begin(LORA_SPI_SCK, LORA_SPI_MISO, LORA_SPI_MOSI, LORA_NSS);

    int8_t tx_power_dbm = LORA_TX_POWER;
    if (tx_power_dbm > LORA_TX_POWER_LIMIT_DBM) tx_power_dbm = LORA_TX_POWER_LIMIT_DBM;

    int state = radio.begin(LORA_FREQUENCY, LORA_BANDWIDTH, LORA_SPREADING_FACTOR,
                            LORA_CODING_RATE, LORA_SYNC_WORD, tx_power_dbm);
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[TRACKER] LoRa init failed: %d\n", state);
        current_state = STATE_ERROR;
        return;
    }

#ifdef LORA_REGION_AU915
    radio.setCRC(LORA_CRC_ENABLED);
    radio.setPreambleLength(LORA_PREAMBLE_LEN);
#endif

    Serial.printf("[TRACKER] LoRa ready: %.2f MHz SF%d BW%.0f kHz\n",
                  LORA_FREQUENCY, LORA_SPREADING_FACTOR, LORA_BANDWIDTH);
    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] TX power: configured=%d dBm active=%d dBm (limit=%d dBm)\n",
                      LORA_TX_POWER, tx_power_dbm, LORA_TX_POWER_LIMIT_DBM);
    }
    radio.setDio0Action(on_lora_rx_done, RISING);
    enter_lora_receive_mode();
}

void init_neopixel() {
    pixel.begin();
    pixel.setPixelColor(0, 0x0000FF);
    pixel.show();
}

void init_battery_monitor() {
#if defined(ESP32)
    analogReadResolution(12);
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);
#endif
    pinMode(BATTERY_ADC_PIN, INPUT);

#if BATTERY_USE_AXP192
    Wire.begin(BATTERY_I2C_SDA, BATTERY_I2C_SCL);
    uint8_t adc_en = 0;
    if (axp192_read_u8(0x82, adc_en)) {
        // Enable battery voltage and current ADC channels.
        adc_en |= 0xC0;
        axp192_write_u8(0x82, adc_en);
    }
#endif

    update_battery_status(millis());
}

bool axp192_read_u8(uint8_t reg, uint8_t& out) {
    Wire.beginTransmission(BATTERY_AXP192_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((uint8_t)BATTERY_AXP192_ADDR, (uint8_t)1) != 1) return false;
    out = Wire.read();
    return true;
}

bool read_battery_percent_axp2101(uint8_t& out_pct) {
    // Probe common SoC registers observed on AXP2101-family boards.
    static const uint8_t candidates[] = { 0xA4, 0xA5, 0xB9 };
    for (uint8_t i = 0; i < sizeof(candidates); i++) {
        uint8_t raw = 0;
        if (!axp192_read_u8(candidates[i], raw)) continue;

        // Some PMUs encode "invalid" in bit7; handle that when present.
        if ((raw & 0x80) != 0 && candidates[i] == 0xB9) continue;
        uint8_t pct = (uint8_t)(raw & 0x7F);
        if (pct <= 100) {
            out_pct = pct;
            return true;
        }
    }
    return false;
}

float read_battery_voltage_axp2101_v() {
    uint8_t vh = 0;
    uint8_t vl = 0;

    // Probe common battery voltage register pairs used by AXP PMUs.
    if (axp192_read_u8(0x34, vh) && axp192_read_u8(0x35, vl)) {
        uint16_t raw = ((uint16_t)vh << 4) | (vl & 0x0F);
        float v = (float)raw / 1000.0f;
        if (v > 2.5f && v < 5.5f) return v;
    }
    if (axp192_read_u8(0x78, vh) && axp192_read_u8(0x79, vl)) {
        uint16_t raw = ((uint16_t)vh << 4) | (vl & 0x0F);
        float v = (float)raw * 1.1f / 1000.0f;
        if (v > 2.5f && v < 5.5f) return v;
    }
    return -1.0f;
}

bool axp192_write_u8(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(BATTERY_AXP192_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

float read_battery_voltage_axp192_v() {
    uint8_t vh = 0;
    uint8_t vl = 0;
    if (!axp192_read_u8(0x78, vh)) return -1.0f;
    if (!axp192_read_u8(0x79, vl)) return -1.0f;

    const uint16_t raw = ((uint16_t)vh << 4) | (vl & 0x0F);
    if (raw == 0) return -1.0f;
    return (float)raw * 1.1f / 1000.0f;
}

bool read_battery_percent_axp192(uint8_t& out_pct) {
    uint8_t raw = 0;
    if (!axp192_read_u8(0xB9, raw)) return false;

    // Bit7 indicates invalid data on AXP192 fuel-gauge register.
    if ((raw & 0x80) != 0) return false;

    out_pct = (uint8_t)(raw & 0x7F);
    if (out_pct > 100) out_pct = 100;
    return true;
}

float read_battery_voltage_v() {
#if BATTERY_USE_AXP192
    const float axp_v = read_battery_voltage_axp192_v();
    if (axp_v > 2.5f && axp_v < 5.5f) {
        return axp_v;
    }
#endif

#if BATTERY_USE_AXP2101
    const float axp2101_v = read_battery_voltage_axp2101_v();
    if (axp2101_v > 2.5f && axp2101_v < 5.5f) {
        return axp2101_v;
    }
#endif

    uint32_t sum = 0;
    const uint8_t samples = 8;
    for (uint8_t i = 0; i < samples; i++) {
        sum += (uint32_t)analogRead(BATTERY_ADC_PIN);
    }

    const float raw = (float)sum / (float)samples;
    return (raw / 4095.0f) * BATTERY_ADC_VREF_V * BATTERY_ADC_DIVIDER_RATIO * BATTERY_CALIBRATION_MULTIPLIER;
}

uint8_t battery_percent_from_voltage(float voltage_v) {
    const float span = BATTERY_FULL_V - BATTERY_EMPTY_V;
    if (span <= 0.01f) return 0;

    float pct = ((voltage_v - BATTERY_EMPTY_V) / span) * 100.0f;
    if (pct < 0.0f) pct = 0.0f;
    if (pct > 100.0f) pct = 100.0f;
    return (uint8_t)lroundf(pct);
}

void update_battery_status(uint32_t now_ms) {
    if (last_battery_sample_ms != 0 && (now_ms - last_battery_sample_ms) < 5000) return;
    last_battery_sample_ms = now_ms;

    const float measured_v = read_battery_voltage_v();

#if BATTERY_USE_AXP192
    uint8_t axp_pct = 0;
    if (read_battery_percent_axp192(axp_pct)) {
        const bool fg_is_zero = (axp_pct == 0);
        const bool near_empty = (measured_v > 0.0f) && (measured_v <= (BATTERY_EMPTY_V + 0.05f));
        const bool trust_fg = !fg_is_zero || near_empty;

        if (trust_fg) {
            if (battery_voltage_v <= 0.01f) {
                battery_voltage_v = measured_v;
            } else {
                battery_voltage_v = (battery_voltage_v * 0.8f) + (measured_v * 0.2f);
            }
            battery_percent = axp_pct;

            if (DIAGNOSTICS_ENABLED) {
                Serial.printf("[TRACKER] Battery: %.3fV (%u%%, src=axp-fg)\n", battery_voltage_v, battery_percent);
            }
            return;
        }

        if (DIAGNOSTICS_ENABLED) {
            Serial.printf("[TRACKER] Battery FG 0%% ignored at %.3fV; using voltage mapping\n", measured_v);
        }
    }
#endif

#if BATTERY_USE_AXP2101
    uint8_t axp2101_pct = 0;
    if (read_battery_percent_axp2101(axp2101_pct)) {
        if (measured_v > 2.0f) {
            if (battery_voltage_v <= 0.01f) {
                battery_voltage_v = measured_v;
            } else {
                battery_voltage_v = (battery_voltage_v * 0.8f) + (measured_v * 0.2f);
            }
        }
        battery_percent = axp2101_pct;
        if (DIAGNOSTICS_ENABLED) {
            Serial.printf("[TRACKER] Battery: %.3fV (%u%%, src=axp2101-fg)\n", battery_voltage_v, battery_percent);
        }
        return;
    }
#endif

    if (!(measured_v > 2.0f && measured_v < 5.5f)) {
        if (DIAGNOSTICS_ENABLED) {
            Serial.printf("[TRACKER] Battery sample invalid (%.3fV), retaining %u%%\n", measured_v, battery_percent);
        }
        return;
    }

    if (battery_voltage_v <= 0.01f) {
        battery_voltage_v = measured_v;
    } else {
        battery_voltage_v = (battery_voltage_v * 0.8f) + (measured_v * 0.2f);
    }
    battery_percent = battery_percent_from_voltage(battery_voltage_v);

    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] Battery: %.3fV (%u%%, src=voltage-map)\n", battery_voltage_v, battery_percent);
    }
}

uint8_t tracker_display_digit() {
    const char* name = TRACKER_NAME;
    if (name && name[0] != '\0') {
        size_t len = strlen(name);
        for (size_t i = len; i > 0; i--) {
            const char c = name[i - 1];
            if (c >= '0' && c <= '9') {
                return (uint8_t)(c - '0');
            }
        }
    }
    return (uint8_t)(CAR_ID % 10);
}

// =============================================================================
//  GPS
// =============================================================================

void update_gps() {
    while (gpsSerial.available()) gps.encode(gpsSerial.read());

    bool updated = gps.location.isUpdated() || gps.speed.isUpdated() ||
                   gps.satellites.isUpdated() || gps.hdop.isUpdated();

    bool has_valid_fix = gps.location.isValid() && gps.location.age() < 2000;
    gps_lock_valid = has_valid_fix;

    // Keep non-position telemetry honest even when lock is missing.
    if (gps.satellites.isValid()) {
        current_gps.sat_count = gps.satellites.value();
    } else {
        current_gps.sat_count = 0;
    }

    if (!has_valid_fix) {
        current_gps.speed_cms = 0;
        return;
    }

    // No new sentence this loop tick; keep prior valid fix data until it ages out.
    if (!updated) return;

    current_gps.latitude   = (int32_t)(gps.location.lat() * 1e7);
    current_gps.longitude  = (int32_t)(gps.location.lng() * 1e7);
    current_gps.speed_cms  = (uint16_t)(gps.speed.mps() * 100.0f);
    current_gps.accuracy   = (gps.hdop.hdop() > 25.5f) ? 255 : (uint8_t)(gps.hdop.hdop() * 10);
    current_gps.sat_count  = gps.satellites.value();
    current_gps.timestamp  = (uint32_t)(millis() / 1000) + server_time_offset;

    log_current_gps_sample(millis());

    if (!gps_lock_announced) {
        gps_lock_announced = true;
        Serial.printf("[TRACKER] GPS fix: lat=%.6f lon=%.6f sats=%d\n",
                      current_gps.latitude / 1e7, current_gps.longitude / 1e7,
                      current_gps.sat_count);
    }

    // Lap crossing detection (only when fully operational and line is configured)
    if (sync_received && start_stop_line.is_configured) {
        static GPSData prev_gps = {};
        uint8_t crossing_type = 0;

        if (calculate_line_crossing(prev_gps, current_gps, start_stop_line, crossing_type)) {
            uint8_t packet[PACKET_LAP_LEN];
            packet[0] = FRAME_LAP_CROSSING;
            packet[1] = CAR_ID;
            memcpy(packet + 2,  &current_gps.timestamp,  4);
            memcpy(packet + 6,  &current_gps.latitude,   4);
            memcpy(packet + 10, &current_gps.longitude,  4);
            packet[14] = crossing_type;
            memcpy(packet + 15, &current_lap, 2);
            packet[17] = calculate_checksum(packet, PACKET_LAP_LEN - 1);
            send_lora_packet(packet, PACKET_LAP_LEN);

            if (crossing_type == 0x01) {
                current_lap++;
                lap_start_time = current_gps.timestamp;
                debug_log("Start line crossed — lap incremented");
            } else {
                debug_log("Finish line crossed");
            }
        }
        prev_gps = current_gps;
    }
}

// =============================================================================
//  LoRa transmit helpers
// =============================================================================

void send_gps_update() {
    uint8_t packet[PACKET_GPS_UPDATE_LEN];
    packet[0] = FRAME_GPS_UPDATE;
    packet[1] = CAR_ID;
    memcpy(packet + 2,  &current_gps.timestamp, 4);
    memcpy(packet + 6,  &current_gps.latitude,  4);
    memcpy(packet + 10, &current_gps.longitude, 4);
    memcpy(packet + 14, &current_gps.speed_cms, 2);
    packet[16] = battery_percent;
    packet[17] = (current_gps.sat_count & 0x7F) | (gps_lock_valid ? 0x80 : 0x00);
    packet[18] = calculate_checksum(packet, PACKET_GPS_UPDATE_LEN - 1);

    send_lora_packet(packet, PACKET_GPS_UPDATE_LEN);

    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] GPS tx: lat=%.6f lon=%.6f spd=%d sats=%d batt=%u%%\n",
                      current_gps.latitude / 1e7, current_gps.longitude / 1e7,
                      current_gps.speed_cms, current_gps.sat_count, battery_percent);
    }
    packets_sent++;
}

void send_register() {
    uint32_t ts = (uint32_t)(millis() / 1000) + server_time_offset;
    uint8_t packet[PACKET_REGISTER_LEN];
    packet[0] = FRAME_REGISTER;
    packet[1] = CAR_ID;
    memcpy(packet + 2,  &ts,                    4);
    memcpy(packet + 6,  &current_gps.latitude,  4);
    memcpy(packet + 10, &current_gps.longitude, 4);
    packet[14] = (uint8_t)CAR_CLASS;
    packet[15] = calculate_checksum(packet, PACKET_REGISTER_LEN - 1);

    send_lora_packet(packet, PACKET_REGISTER_LEN);
    debug_log("REGISTER sent — awaiting gateway ACK");
}

void send_driver_alert() {
    uint32_t ts = (uint32_t)(millis() / 1000) + server_time_offset;
    uint8_t packet[PACKET_ALERT_LEN];
    packet[0] = FRAME_ALERT;
    packet[1] = CAR_ID;
    memcpy(packet + 2,  &ts,                    4);
    memcpy(packet + 6,  &current_gps.latitude,  4);
    memcpy(packet + 10, &current_gps.longitude, 4);
    packet[14] = ALERT_DRIVER_REQUEST;
    packet[15] = calculate_checksum(packet, PACKET_ALERT_LEN - 1);
    send_lora_packet(packet, PACKET_ALERT_LEN);
    alert_latched = true;
    blink_led(0xFF0000, 500);
    debug_log("Driver alert sent");
}

// =============================================================================
//  Button / alert
// =============================================================================

void check_button_alert() {
    uint32_t now_ms = millis();
    bool raw_pressed = (digitalRead(BUTTON_PIN) == LOW);

    if (raw_pressed != button_raw_state) {
        button_raw_state = raw_pressed;
        button_last_change_ms = now_ms;
    }

    // Wait until the input has been stable for the full debounce interval.
    if (now_ms - button_last_change_ms < BUTTON_DEBOUNCE_MS) return;

    if (button_raw_state && !button_was_pressed) {
        button_press_start = now_ms;
        button_was_pressed = true;
        button_alert_sent = false;
        button_long_hold_armed = false;
        return;
    }

    if (button_raw_state && button_was_pressed) {
        uint32_t held = now_ms - button_press_start;
        if (held > GPS_LOG_UPLOAD_HOLD_MS) button_long_hold_armed = true;
        return;
    }

    if (!button_raw_state && button_was_pressed) {
        uint32_t held = now_ms - button_press_start;
        button_was_pressed = false;
        bool do_upload = button_long_hold_armed || (held > GPS_LOG_UPLOAD_HOLD_MS);
        button_long_hold_armed = false;
        if (DIAGNOSTICS_ENABLED) {
            Serial.printf("[TRACKER] Button held %lu ms\n", (unsigned long)held);
        }

        if (do_upload) {
            show_upload_hold_feedback();
            if (!upload_logs_via_wifi()) blink_led(0xFF0000, 800);
        } else if (held >= BUTTON_ALERT_HOLD_MS && !button_alert_sent) {
            send_driver_alert();
            button_alert_sent = true;
        }
    }
}

// =============================================================================
//  GPS logging (LittleFS)
// =============================================================================

bool ensure_log_file_header_for_path(const String& file_path) {
    if (!storage_ready) return false;

    if (LittleFS.exists(file_path)) {
        File f = LittleFS.open(file_path, FILE_READ);
        bool has_content = f && f.size() > 0;
        if (f) f.close();
        if (has_content) return true;
    }

    File f = LittleFS.open(file_path, FILE_WRITE);
    if (!f) { Serial.println("[TRACKER] Cannot create GPS log file"); return false; }
    size_t w = f.print(GPS_LOG_HEADER);
    f.close();
    return w == strlen(GPS_LOG_HEADER);
}

String sanitize_filename_component(const String& input) {
    String out;
    out.reserve(input.length());
    for (size_t i = 0; i < input.length(); i++) {
        char c = input.charAt(i);
        bool ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '-' || c == '_';
        out += ok ? c : '_';
    }
    if (out.length() == 0) out = "tracker";
    return out;
}

bool is_plausible_unix_time(uint32_t unix_time) {
    return unix_time >= 1704067200UL;  // 2024-01-01 UTC
}

String build_log_date_label(uint32_t unix_time) {
    if (!is_plausible_unix_time(unix_time)) return "unsynced";
    time_t t = (time_t)unix_time;
    struct tm ti;
    if (!gmtime_r(&t, &ti)) return "unsynced";
    char buf[16];
    strftime(buf, sizeof(buf), "%Y-%m-%d", &ti);
    return String(buf);
}

String active_gps_log_file_path() {
    String trackerName = sanitize_filename_component(String(TRACKER_NAME));
    String dateLabel = build_log_date_label(current_gps.timestamp);
    return String(GPS_LOG_DIR) + "/" + trackerName + "_" + dateLabel + ".csv";
}

bool extract_log_date_from_filename(const String& file_path, String& out_date) {
    int slash = file_path.lastIndexOf('/');
    String name = (slash >= 0) ? file_path.substring(slash + 1) : file_path;
    int underscore = name.lastIndexOf('_');
    int dot = name.lastIndexOf('.');
    if (underscore < 0 || dot < 0 || dot <= underscore + 1) return false;
    out_date = name.substring(underscore + 1, dot);
    return out_date.length() == 10;
}

bool cleanup_old_log_files(uint32_t now_unix) {
    if (!storage_ready) return false;
    if (!is_plausible_unix_time(now_unix)) return false;

    File dir = LittleFS.open(GPS_LOG_DIR, FILE_READ);
    if (!dir || !dir.isDirectory()) return false;

    uint32_t deleted = 0;
    File f = dir.openNextFile();
    while (f) {
        String path = normalize_log_path(String(f.name()));
        if (!f.isDirectory()) {
            String date;
            if (extract_log_date_from_filename(path, date) && date != "unsynced") {
                int y = 0, m = 0, d = 0;
                if (sscanf(date.c_str(), "%d-%d-%d", &y, &m, &d) == 3) {
                    struct tm ti = {};
                    ti.tm_year = y - 1900;
                    ti.tm_mon = m - 1;
                    ti.tm_mday = d;
                    ti.tm_hour = 0;
                    ti.tm_min = 0;
                    ti.tm_sec = 0;
                    time_t file_day = mktime(&ti);
                    if (file_day > 0 && (uint32_t)file_day + GPS_LOG_MAX_AGE_SECONDS < now_unix) {
                        f.close();
                        if (LittleFS.remove(path)) deleted++;
                        f = dir.openNextFile();
                        continue;
                    }
                }
            }
        }
        f.close();
        f = dir.openNextFile();
    }
    dir.close();
    if (deleted > 0) Serial.printf("[TRACKER] Deleted %lu old GPS log file(s)\n", (unsigned long)deleted);
    return true;
}

void log_current_gps_sample(uint32_t now_ms) {
    char line[128];
    snprintf(line, sizeof(line), "%lu,%lu,%.7f,%.7f,%u,%u,%u\n",
             (unsigned long)current_gps.timestamp,
             (unsigned long)now_ms,
             current_gps.latitude  / 1e7f,
             current_gps.longitude / 1e7f,
             current_gps.speed_cms,
             current_gps.accuracy,
             current_gps.sat_count);

    pending_log_buffer += line;

    // Keep bounded memory by retaining only the newest rows when logs grow too large.
    if (pending_log_buffer.length() > GPS_LOG_RAM_MAX_BYTES) {
        int32_t trim_from = (int32_t)pending_log_buffer.length() - (int32_t)GPS_LOG_RAM_MAX_BYTES;
        int32_t newline_at = pending_log_buffer.indexOf('\n', trim_from);
        if (newline_at >= 0) {
            pending_log_buffer.remove(0, newline_at + 1);
        } else {
            pending_log_buffer = "";
        }
    }

    if (storage_ready && pending_log_buffer.length() >= GPS_LOG_BUFFER_BYTES) {
        flush_log_buffer(true);
    }
}

bool flush_log_buffer(bool force) {
    if (pending_log_buffer.length() == 0) return true;
    if (!storage_ready) return true;

    uint32_t now_ms = millis();
    if (!force && (now_ms - last_log_flush_ms) < GPS_LOG_WRITE_INTERVAL_MS) return true;

    String nextPath = active_gps_log_file_path();
    if (nextPath != current_log_file_path) current_log_file_path = nextPath;
    if (!ensure_log_file_header_for_path(current_log_file_path)) return false;

    File f = LittleFS.open(current_log_file_path, FILE_APPEND);
    if (!f) { Serial.println("[TRACKER] Cannot append GPS log"); return false; }

    size_t expected = pending_log_buffer.length();
    size_t written  = f.print(pending_log_buffer);
    f.close();

    if (written != expected) { Serial.println("[TRACKER] Incomplete log flush"); return false; }

    pending_log_buffer = "";
    last_log_flush_ms  = now_ms;
    return true;
}

// =============================================================================
//  WiFi log upload
// =============================================================================

bool should_enter_ota_mode_on_boot() {
    if (!OTA_ENABLED) return false;
    if (digitalRead(BUTTON_PIN) != LOW) return false;

    uint32_t start_ms = millis();
    while (millis() - start_ms < OTA_BOOT_HOLD_MS) {
        if (digitalRead(BUTTON_PIN) != LOW) return false;
        delay(10);
    }
    return true;
}

bool start_ota_mode() {
    if (strlen(WIFI_SSID) == 0) {
        Serial.println("[TRACKER] OTA unavailable: WIFI_SSID empty");
        return false;
    }

    WiFi.disconnect(true);
    delay(100);
    WiFi.mode(WIFI_STA);
    delay(100);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("[TRACKER] OTA WiFi connecting to: %s\n", WIFI_SSID);

    uint32_t start_ms = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start_ms < OTA_WIFI_CONNECT_TIMEOUT_MS) {
        delay(250);
    }
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[TRACKER] OTA WiFi connect timeout (status=%d)\n", (int)WiFi.status());
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
        return false;
    }

    snprintf(ota_hostname, sizeof(ota_hostname), "%s-%u", OTA_HOSTNAME_PREFIX, (unsigned)CAR_ID);
    ArduinoOTA.setHostname(ota_hostname);
    if (strlen(OTA_PASSWORD) > 0) {
        ArduinoOTA.setPassword(OTA_PASSWORD);
    }

    ArduinoOTA.onStart([]() {
        Serial.println("[TRACKER][OTA] Start");
    });
    ArduinoOTA.onEnd([]() {
        Serial.println("[TRACKER][OTA] End");
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("[TRACKER][OTA] Error: %u\n", (unsigned)error);
    });
    ArduinoOTA.begin();

    ota_mode_active = true;
    set_led_status(0xFF00FF);
    Serial.printf("[TRACKER][OTA] Ready: host=%s ip=%s\n", ota_hostname, WiFi.localIP().toString().c_str());
    return true;
}

void handle_ota_mode_loop(uint32_t now_ms) {
    ArduinoOTA.handle();
    bool on = ((now_ms / 300) % 2) == 0;
    set_led_status(on ? 0xFF00FF : 0x000000);
    delay(2);
}

bool connect_wifi_for_upload() {
    if (strlen(WIFI_SSID) == 0 || strlen(GPS_LOG_UPLOAD_URL) == 0) {
        Serial.println("[TRACKER] WiFi upload not configured");
        return false;
    }
    WiFi.disconnect(true);
    delay(100);
    WiFi.mode(WIFI_STA);
    delay(100);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("[TRACKER] WiFi connecting to: %s\n", WIFI_SSID);

    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
        delay(250);
    }
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[TRACKER] WiFi connect timeout (status=%d)\n", (int)WiFi.status());
        return false;
    }
    if (DIAGNOSTICS_ENABLED)
        Serial.printf("[TRACKER] WiFi: %s\n", WiFi.localIP().toString().c_str());
    return true;
}

void disconnect_wifi_after_upload() {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
}

bool upload_single_log_file(const String& file_path) {
    File f = LittleFS.open(file_path, FILE_READ);
    if (!f) {
        Serial.printf("[TRACKER] Cannot open log file: %s\n", file_path.c_str());
        return false;
    }

    String logDate = "unknown";
    extract_log_date_from_filename(file_path, logDate);

    String fileName = file_path;
    int slash = fileName.lastIndexOf('/');
    if (slash >= 0) fileName = fileName.substring(slash + 1);

    HTTPClient http;
    http.begin(GPS_LOG_UPLOAD_URL);
    http.addHeader("Content-Type", "text/csv");
    http.addHeader("X-Tracker-Id",   String(CAR_ID));
    http.addHeader("X-Tracker-Name", TRACKER_NAME);
    http.addHeader("X-Log-Date",     logDate);
    http.addHeader("X-Log-File",     fileName);

    int code = http.sendRequest("POST", &f, f.size());
    String body = (code > 0) ? http.getString() : "";
    f.close();
    http.end();

    if (code >= 200 && code < 300) {
        if (!LittleFS.remove(file_path)) {
            Serial.printf("[TRACKER] Uploaded but could not delete: %s\n", file_path.c_str());
            return false;
        }
        return true;
    }

    Serial.printf("[TRACKER] Upload failed for %s: %d %s\n", file_path.c_str(), code, body.c_str());
    return false;
}

bool upload_pending_log_buffer() {
    if (pending_log_buffer.length() == 0) {
        Serial.println("[TRACKER] No pending in-memory GPS rows to upload");
        return false;
    }

    String logDate = build_log_date_label(current_gps.timestamp);
    String fileName = sanitize_filename_component(String(TRACKER_NAME)) + "_" + logDate + "_live.csv";
    String payload;
    payload.reserve(strlen(GPS_LOG_HEADER) + pending_log_buffer.length());
    payload += GPS_LOG_HEADER;
    payload += pending_log_buffer;

    HTTPClient http;
    http.begin(GPS_LOG_UPLOAD_URL);
    http.addHeader("Content-Type", "text/csv");
    http.addHeader("X-Tracker-Id", String(CAR_ID));
    http.addHeader("X-Tracker-Name", TRACKER_NAME);
    http.addHeader("X-Log-Date", logDate);
    http.addHeader("X-Log-File", fileName);

    int code = http.sendRequest("POST", payload);
    String body = (code > 0) ? http.getString() : "";
    http.end();

    if (code >= 200 && code < 300) {
        pending_log_buffer = "";
        return true;
    }

    Serial.printf("[TRACKER] In-memory upload failed: %d %s\n", code, body.c_str());
    return false;
}

bool upload_logs_via_wifi() {
    if (strlen(WIFI_SSID) == 0 || strlen(GPS_LOG_UPLOAD_URL) == 0) {
        Serial.println("[TRACKER] WiFi upload not configured");
        return false;
    }
    bool has_position = (current_gps.latitude != 0 || current_gps.longitude != 0);
    if (gps_lock_valid || has_position) {
        // Ensure a long-hold upload includes at least one current GPS row.
        log_current_gps_sample(millis());
    }

    if (storage_ready && !flush_log_buffer(true)) {
        Serial.println("[TRACKER] Flush failed");
        return false;
    }

    if (!storage_ready && pending_log_buffer.length() == 0) {
        Serial.println("[TRACKER] No in-memory GPS logs to upload");
        return false;
    }

    if (!connect_wifi_for_upload()) { return false; }

    set_led_status(0x00FFFF);

    if (!storage_ready) {
        bool uploaded = upload_pending_log_buffer();
        disconnect_wifi_after_upload();
        if (uploaded) {
            blink_led(0x00FFFF, 1200);
            debug_log("In-memory GPS logs uploaded");
            return true;
        }
        Serial.println("[TRACKER] In-memory GPS log upload failed");
        return false;
    }

    File dir = LittleFS.open(GPS_LOG_DIR, FILE_READ);
    if (!dir || !dir.isDirectory()) {
        disconnect_wifi_after_upload();
        Serial.println("[TRACKER] /gps directory missing");
        return false;
    }

    bool anyFile = false;
    bool allOk = true;

    File f = dir.openNextFile();
    while (f) {
        String path = normalize_log_path(String(f.name()));
        bool isRegular = !f.isDirectory();
        f.close();
        if (isRegular && path.endsWith(".csv")) {
            anyFile = true;
            if (!upload_single_log_file(path)) allOk = false;
        }
        f = dir.openNextFile();
    }
    dir.close();
    disconnect_wifi_after_upload();

    if (!anyFile) {
        Serial.println("[TRACKER] No GPS log files to upload");
        return false;
    }

    current_log_file_path = active_gps_log_file_path();
    ensure_log_file_header_for_path(current_log_file_path);

    if (allOk) {
        blink_led(0x00FFFF, 1200);
        debug_log("All GPS logs uploaded and cleared");
        return true;
    }

    Serial.println("[TRACKER] One or more GPS log uploads failed; remaining files kept");
    return false;
}

String normalize_log_path(const String& entry_name) {
    if (entry_name.length() == 0) return entry_name;
    if (entry_name.charAt(0) == '/') return entry_name;
    return String(GPS_LOG_DIR) + "/" + entry_name;
}

// =============================================================================
//  LoRa core
// =============================================================================

void send_lora_packet(uint8_t* packet, uint8_t len) {
    lora_listening = false;
    lora_rx_flag = false;
    int state = radio.transmit(packet, len);
    if (state != RADIOLIB_ERR_NONE) {
        lora_errors++;
        tx_packets_err++;
        if (DIAGNOSTICS_ENABLED) Serial.printf("[TRACKER] TX err %d\n", state);
    } else if (DIAGNOSTICS_ENABLED) {
        tx_packets_ok++;
        Serial.printf("[TRACKER] TX %d bytes type=0x%02X\n", len, packet[0]);
    } else {
        tx_packets_ok++;
    }
    enter_lora_receive_mode();
}

void enter_lora_receive_mode() {
    int s = radio.startReceive();
    if (s == RADIOLIB_ERR_NONE) {
        lora_listening = true;
    } else {
        lora_listening = false;
        if (DIAGNOSTICS_ENABLED) Serial.printf("[TRACKER] RX mode err %d\n", s);
    }
}

void apply_sync(uint8_t* data, uint8_t len) {
    if (len != PACKET_SYNC_LEN) return;

    LoRaSyncPacket pkt;
    memcpy(&pkt, data, PACKET_SYNC_LEN);

    server_time_offset = pkt.server_timestamp - (uint32_t)(millis() / 1000);
    last_sync_time     = pkt.server_timestamp;

    if (pkt.config_version != start_stop_line.config_version) {
        start_stop_line.lat1           = pkt.line_lat1;
        start_stop_line.lon1           = pkt.line_lon1;
        start_stop_line.lat2           = pkt.line_lat2;
        start_stop_line.lon2           = pkt.line_lon2;
        start_stop_line.width_m        = pkt.line_width_m;
        start_stop_line.config_version = pkt.config_version;
        start_stop_line.is_configured  = (pkt.line_width_m > 0);
        debug_log("Start/stop line config updated");
    }

    if (!sync_received) {
        sync_received  = true;
        registered     = true;
        current_state  = STATE_OPERATIONAL;
        debug_log("Registration ACK — now OPERATIONAL");
    } else {
        debug_log("Periodic sync applied");
    }

    if (storage_ready && !old_log_cleanup_done && is_plausible_unix_time(pkt.server_timestamp)) {
        cleanup_old_log_files(pkt.server_timestamp);
        old_log_cleanup_done = true;
    }
    sync_packets_applied++;
}

void apply_alert_control(uint8_t* data, uint8_t len) {
    if (len != PACKET_ALERT_CONTROL_LEN) return;
    bool next_state = (data[6] != 0);
    alert_latched = next_state;
    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] Alert mode %s via gateway control\n", alert_latched ? "ENABLED" : "CLEARED");
    }
}

void process_lora_packet(uint8_t* data, uint8_t len) {
    if (len < 3) return;

    uint8_t cs_rx   = data[len - 1];
    uint8_t cs_calc = calculate_checksum(data, len - 1);
    if (cs_rx != cs_calc) {
        if (DIAGNOSTICS_ENABLED)
            Serial.printf("[TRACKER] Checksum fail rx=%02X calc=%02X\n", cs_rx, cs_calc);
        return;
    }

    uint8_t frame_type = data[0];
    uint8_t target_id  = data[1];

    if (target_id != CAR_ID && target_id != 0xFF) return;

    if ((frame_type == FRAME_SYNC || frame_type == FRAME_REGISTER_ACK) &&
        len == PACKET_SYNC_LEN) {
        apply_sync(data, len);
    } else if (frame_type == FRAME_ALERT_CONTROL && len == PACKET_ALERT_CONTROL_LEN) {
        apply_alert_control(data, len);
    } else if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[TRACKER] Unknown frame 0x%02X len=%d\n", frame_type, len);
    }
}

// =============================================================================
//  Line crossing geometry
// =============================================================================

float distance_to_line(float lat, float lon, StartStopLine line) {
    float lat1 = line.lat1 / 1e7f, lon1 = line.lon1 / 1e7f;
    float lat2 = line.lat2 / 1e7f, lon2 = line.lon2 / 1e7f;

    float A  = lat2 - lat1, B = lon2 - lon1;
    float C  = lat  - lat1, D = lon  - lon1;
    float len_sq = A * A + B * B;
    if (len_sq == 0) return 0;

    float t = (A * C + B * D) / len_sq;
    t = constrain(t, 0.0f, 1.0f);

    float dx = lat - (lat1 + t * A);
    float dy = lon - (lon1 + t * B);
    return sqrtf(dx * dx + dy * dy) * 111000.0f;  // approx metres/degree
}

bool calculate_line_crossing(GPSData prev, GPSData curr, StartStopLine line, uint8_t& crossing_type) {
    float half_w = line.width_m / 2.0f;
    float d_prev = distance_to_line(prev.latitude / 1e7f, prev.longitude / 1e7f, line);
    float d_curr = distance_to_line(curr.latitude / 1e7f, curr.longitude / 1e7f, line);

    if ((d_prev >  half_w && d_curr <  half_w) ||
        (d_prev < -half_w && d_curr > -half_w)) {
        crossing_type = 0x01;  // simplified: treat every crossing as start
        return true;
    }
    return false;
}

// =============================================================================
//  Utilities
// =============================================================================

uint8_t calculate_checksum(uint8_t* data, uint8_t len) {
    uint8_t cs = 0;
    for (uint8_t i = 0; i < len; i++) cs ^= data[i];
    return cs;
}

float compute_lora_airtime_ms(uint8_t payload_len) {
    const float bw_hz = LORA_BANDWIDTH * 1000.0f;
    const int sf = LORA_SPREADING_FACTOR;
    const int cr = LORA_CODING_RATE - 4;
    const int crc_on = LORA_CRC_ENABLED ? 1 : 0;
    const int ih = 0;
    const int de = (sf >= 11 && LORA_BANDWIDTH <= 125.0f) ? 1 : 0;

    const float t_sym = (float)(1UL << sf) / bw_hz;
    const float preamble = (LORA_PREAMBLE_LEN + 4.25f) * t_sym;
    const float num = (8.0f * payload_len) - (4.0f * sf) + 28.0f + (16.0f * crc_on) - (20.0f * ih);
    const float den = 4.0f * (sf - (2.0f * de));
    const float n_payload = 8.0f + fmaxf(ceilf(num / den) * (cr + 4), 0.0f);
    return (preamble + n_payload * t_sym) * 1000.0f;
}

uint32_t compute_budgeted_interval_ms(uint8_t payload_len, uint16_t node_count) {
    if (node_count == 0) node_count = 1;
    uint16_t util_permille = LINK_BUDGET_TARGET_CHANNEL_UTIL_PERMILLE;
    if (util_permille == 0) util_permille = 1;

    float airtime_ms = compute_lora_airtime_ms(payload_len);
    float min_interval = (airtime_ms * node_count * 1000.0f) / util_permille;
    min_interval *= (LINK_BUDGET_INTERVAL_MULTIPLIER > 0) ? LINK_BUDGET_INTERVAL_MULTIPLIER : 1;
    uint32_t budgeted_ms = (uint32_t)ceilf(min_interval);
    if (budgeted_ms < GPS_UPDATE_INTERVAL_MS) budgeted_ms = GPS_UPDATE_INTERVAL_MS;
    return budgeted_ms;
}

void log_diagnostics(uint32_t now_ms) {
    if (!DIAGNOSTICS_ENABLED) return;
    if (now_ms - last_diag_report_ms < DIAGNOSTIC_REPORT_INTERVAL_MS) return;
    last_diag_report_ms = now_ms;

    Serial.printf("[TRACKER][STATS] tx_ok=%lu tx_err=%lu rx_ok=%lu rx_crc=%lu rx_hdr=%lu rx_other=%lu sync=%lu gps_int=%lu fs=%s\n",
                  (unsigned long)tx_packets_ok,
                  (unsigned long)tx_packets_err,
                  (unsigned long)rx_packets_ok,
                  (unsigned long)rx_crc_fail,
                  (unsigned long)rx_header_fail,
                  (unsigned long)rx_other_errors,
                  (unsigned long)sync_packets_applied,
                  (unsigned long)effective_gps_interval_ms,
                  storage_ready ? "ok" : "FAIL");
}

void set_led_status(uint32_t color) { pixel.setPixelColor(0, color); pixel.show(); }

void blink_led(uint32_t color, uint16_t ms) {
    set_led_status(color); delay(ms / 2);
    set_led_status(0);     delay(ms / 2);
}

// =============================================================================
//  5×5 NeoPixel matrix
// =============================================================================

// Map (row, col) to NeoPixel index, honouring MATRIX_SERPENTINE wiring.
static inline uint16_t matrix_pixel_index(uint8_t row, uint8_t col) {
#if MATRIX_SERPENTINE
    return (row % 2 == 1) ? (row * 5 + (4 - col)) : (row * 5 + col);
#else
    return row * 5 + col;
#endif
}

void init_matrix() {
    matrix_leds.begin();
    matrix_leds.setBrightness(MATRIX_BRIGHTNESS);
    matrix_leds.clear();
    matrix_leds.show();
}

static void matrix_clear() {
    matrix_leds.clear();
}

// Fill all 25 pixels with a single colour.
static void matrix_fill(uint32_t color) {
    for (uint8_t i = 0; i < 25; i++) matrix_leds.setPixelColor(i, color);
}

// Render one digit (0–9) centred on the 5×5 grid using white pixels.
static void matrix_show_digit(uint8_t digit) {
    if (digit > 9) digit = 0;
    matrix_clear();
    for (uint8_t row = 0; row < 5; row++) {
        uint8_t bits = DIGIT_BITMAP[digit][row];
        for (uint8_t col = 0; col < 5; col++) {
            if (bits & (1 << (4 - col))) {
                matrix_leds.setPixelColor(matrix_pixel_index(row, col), 0xFFFFFF);
            }
        }
    }
}

// Called every loop iteration.  Drives the slow-blink pattern with digit on "off" phase.
void update_matrix_display(uint32_t now_ms) {
    if (alert_latched) {
        bool red_phase = ((now_ms / 150) % 2) == 0;
        matrix_fill(red_phase ? matrix_leds.Color(255, 0, 0) : matrix_leds.Color(0, 0, 255));
        matrix_leds.show();
        return;
    }

    // Determine status colour.
    uint32_t status_color;
    if (current_state == STATE_ERROR) {
        status_color = matrix_leds.Color(255, 0, 0);      // red   — fault
    } else if (current_state == STATE_OPERATIONAL && sync_received && gps_lock_valid) {
        status_color = matrix_leds.Color(0, 220, 0);      // green — no fault
    } else {
        status_color = matrix_leds.Color(255, 80, 0);     // orange — no GPS lock
    }

    // Blink: first half of period = solid colour, second half = digit.
    uint32_t phase = now_ms % MATRIX_BLINK_PERIOD_MS;
    if (phase < (MATRIX_BLINK_PERIOD_MS / 2)) {
        matrix_fill(status_color);
    } else {
        matrix_show_digit(tracker_display_digit());
    }
    matrix_leds.show();
}

void show_upload_hold_feedback() {
    // Match the normal matrix blink cadence: white phase, then car number.
    matrix_fill(matrix_leds.Color(255, 255, 255));
    matrix_leds.show();
    delay(MATRIX_BLINK_PERIOD_MS / 2);
    matrix_show_digit(tracker_display_digit());
    matrix_leds.show();
    delay(MATRIX_BLINK_PERIOD_MS / 2);
}

void debug_log(const char* msg) {
    if (DIAGNOSTICS_ENABLED) Serial.printf("[TRACKER] %s\n", msg);
}
