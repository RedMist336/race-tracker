// Race Tracking — Gateway Firmware
// Hardware: TTGO TBeam v1.2  (ESP32 + SX1276 LoRa — no GPS needed)
//
// Responsibilities:
//   1. Listen continuously for LoRa packets from tracker nodes
//   2. Validate checksum
//   3. Decode binary packet → JSON
//   4. HTTP POST JSON to Node.js server  (buffers up to RING_BUFFER_SIZE packets
//      during WiFi outages and drains the buffer on reconnect)
//   5. Periodically broadcast FRAME_SYNC to all trackers so their clocks stay
//      aligned (server timestamp fetched via GET /api/sync)

#include <Arduino.h>
#include "config.h"

#include <RadioLib.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <HardwareSerial.h>
#include <ArduinoOTA.h>
#include <math.h>

// =============================================================================
//  Packet frame type constants  (shared with tracker firmware)
// =============================================================================

static const uint8_t FRAME_GPS_UPDATE   = 0x01;
static const uint8_t FRAME_ALERT        = 0x02;
static const uint8_t FRAME_LAP_CROSSING = 0x03;
static const uint8_t FRAME_SYNC         = 0x04;
static const uint8_t FRAME_REGISTER     = 0x05;
static const uint8_t FRAME_REGISTER_ACK = 0x06;
static const uint8_t FRAME_ALERT_CONTROL = 0x07;

static const uint8_t PACKET_GPS_UPDATE_LEN  = 19;
static const uint8_t PACKET_ALERT_LEN       = 16;
static const uint8_t PACKET_LAP_LEN         = 18;
static const uint8_t PACKET_SYNC_LEN        = 27;
static const uint8_t PACKET_REGISTER_LEN    = 16;
static const uint8_t PACKET_ALERT_CONTROL_LEN = 8;
static const uint32_t CONTROL_POLL_INTERVAL_MS = 1000;

static char car_class_code[256] = {0};

static bool is_valid_class_code(uint8_t code) {
    return code == 'C' || code == 'U' || code == 'M' || code == 'J' || code == 'S';
}

static String format_car_name(uint8_t car_id) {
    uint8_t cls = (uint8_t)car_class_code[car_id];
    if (is_valid_class_code(cls)) {
        String out;
        out += (char)cls;
        out += String(car_id);
        return out;
    }
    return String("Car ") + String(car_id);
}

// =============================================================================
//  Ring buffer for offline queuing
// =============================================================================

struct QueuedPacket {
    uint8_t data[32];
    uint8_t len;
    bool    used;
};

static QueuedPacket ring_buffer[RING_BUFFER_SIZE];
static uint8_t ring_head = 0;
static uint8_t ring_tail = 0;

void ring_push(const uint8_t* data, uint8_t len) {
    uint8_t next = (ring_head + 1) % RING_BUFFER_SIZE;
    if (next == ring_tail) {
        // Buffer full — drop oldest
        ring_tail = (ring_tail + 1) % RING_BUFFER_SIZE;
        if (DIAGNOSTICS_ENABLED) Serial.println("[GATEWAY] Ring buffer full — oldest packet dropped");
    }
    if (len > sizeof(ring_buffer[ring_head].data)) len = sizeof(ring_buffer[ring_head].data);
    memcpy(ring_buffer[ring_head].data, data, len);
    ring_buffer[ring_head].len  = len;
    ring_buffer[ring_head].used = true;
    ring_head = next;
}

bool ring_empty() { return ring_head == ring_tail; }

QueuedPacket* ring_peek() {
    if (ring_empty()) return nullptr;
    return &ring_buffer[ring_tail];
}

void ring_pop() {
    if (!ring_empty()) ring_tail = (ring_tail + 1) % RING_BUFFER_SIZE;
}

// =============================================================================
//  LoRa
// =============================================================================

SPIClass spi;
SX1276 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST, LORA_DIO1, spi);
volatile bool lora_rx_flag = false;
volatile bool lora_listening = false;
uint32_t effective_sync_interval_ms = SYNC_BROADCAST_INTERVAL_MS;
#if !UPLINK_USE_USB_SERIAL
HardwareSerial uplinkSerial(2);
#endif

static inline void uplink_send_json(const String& json) {
    if (!UPLINK_TRANSPORT_SERIAL) return;
#if UPLINK_USE_USB_SERIAL
    Serial.print(UPLINK_JSON_PREFIX);
    Serial.println(json);
#else
    uplinkSerial.print(UPLINK_JSON_PREFIX);
    uplinkSerial.println(json);
#endif
}

uint32_t rx_packets_ok       = 0;
uint32_t rx_crc_fail         = 0;
uint32_t rx_header_fail      = 0;
uint32_t rx_other_errors     = 0;
uint32_t tx_sync_ok          = 0;
uint32_t tx_sync_err         = 0;
uint32_t register_acks_sent  = 0;
uint32_t sync_broadcasts_sent = 0;
uint32_t last_diag_report_ms = 0;
uint32_t last_control_poll_ms = 0;

void fetch_server_sync();

struct __attribute__((packed)) LoRaAlertControl {
    uint8_t  frame_type;
    uint8_t  car_id;
    uint32_t server_timestamp;
    uint8_t  alert_active;
    uint8_t  checksum;
};

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

uint32_t compute_budgeted_sync_interval_ms() {
    uint16_t util_permille = LINK_BUDGET_TARGET_CHANNEL_UTIL_PERMILLE;
    if (util_permille == 0) util_permille = 1;

    uint16_t talkers = (LINK_BUDGET_EXPECTED_NODES == 0) ? 2 : (LINK_BUDGET_EXPECTED_NODES + 1);
    float airtime_ms = compute_lora_airtime_ms(PACKET_SYNC_LEN);
    float min_interval = (airtime_ms * talkers * 1000.0f) / util_permille;
    min_interval *= (LINK_BUDGET_INTERVAL_MULTIPLIER > 0) ? LINK_BUDGET_INTERVAL_MULTIPLIER : 1;
    uint32_t budgeted_ms = (uint32_t)ceilf(min_interval);
    if (budgeted_ms < SYNC_BROADCAST_INTERVAL_MS) budgeted_ms = SYNC_BROADCAST_INTERVAL_MS;
    return budgeted_ms;
}

void log_diagnostics(uint32_t now_ms) {
    if (!DIAGNOSTICS_ENABLED) return;
    if (now_ms - last_diag_report_ms < DIAGNOSTIC_REPORT_INTERVAL_MS) return;
    last_diag_report_ms = now_ms;

    Serial.printf("[GATEWAY][STATS] tx_ok=%lu tx_err=%lu rx_ok=%lu rx_crc=%lu rx_hdr=%lu rx_other=%lu ack=%lu sync_bcast=%lu sync_int=%lu\n",
                  (unsigned long)tx_sync_ok,
                  (unsigned long)tx_sync_err,
                  (unsigned long)rx_packets_ok,
                  (unsigned long)rx_crc_fail,
                  (unsigned long)rx_header_fail,
                  (unsigned long)rx_other_errors,
                  (unsigned long)register_acks_sent,
                  (unsigned long)sync_broadcasts_sent,
                  (unsigned long)effective_sync_interval_ms);
}

#if defined(ESP32)
void IRAM_ATTR on_lora_rx_done() {
    if (lora_listening) lora_rx_flag = true;
}
#else
void on_lora_rx_done() {
    if (lora_listening) lora_rx_flag = true;
}
#endif

void enter_lora_receive_mode() {
    int s = radio.startReceive();
    if (s == RADIOLIB_ERR_NONE) {
        lora_listening = true;
    } else {
        lora_listening = false;
        if (DIAGNOSTICS_ENABLED) Serial.printf("[GATEWAY] RX mode err %d\n", s);
    }
}

void init_lora() {
    spi.begin(LORA_SPI_SCK, LORA_SPI_MISO, LORA_SPI_MOSI, LORA_NSS);

    int8_t tx_power_dbm = LORA_TX_POWER;
    if (tx_power_dbm > LORA_TX_POWER_LIMIT_DBM) tx_power_dbm = LORA_TX_POWER_LIMIT_DBM;

    int state = radio.begin(LORA_FREQUENCY, LORA_BANDWIDTH, LORA_SPREADING_FACTOR,
                            LORA_CODING_RATE, LORA_SYNC_WORD, tx_power_dbm);
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[GATEWAY] LoRa init failed: %d\n", state);
        while (true) delay(1000);
    }

#ifdef LORA_REGION_AU915
    radio.setCRC(LORA_CRC_ENABLED);
    radio.setPreambleLength(LORA_PREAMBLE_LEN);
#endif

    Serial.printf("[GATEWAY] LoRa ready: %.2f MHz SF%d BW%.0f kHz\n",
                  LORA_FREQUENCY, LORA_SPREADING_FACTOR, LORA_BANDWIDTH);
    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[GATEWAY] TX power: configured=%d dBm active=%d dBm (limit=%d dBm)\n",
                      LORA_TX_POWER, tx_power_dbm, LORA_TX_POWER_LIMIT_DBM);
    }
    radio.setDio0Action(on_lora_rx_done, RISING);
    enter_lora_receive_mode();
}

// =============================================================================
//  WiFi
// =============================================================================

bool wifi_connected = false;
uint32_t last_wifi_check_ms = 0;
bool ota_mode_active = false;

bool should_enter_ota_mode_on_boot();
bool start_ota_mode();
void handle_ota_mode_loop();

void connect_wifi() {
    if (UPLINK_TRANSPORT_SERIAL) {
        wifi_connected = false;
        return;
    }
    if (strlen(WIFI_SSID) == 0) return;
    WiFi.disconnect(true);   // clear cached SSID/credentials from NVS
    delay(100);
    WiFi.mode(WIFI_STA);

    IPAddress local_ip(WIFI_STATIC_IP_0, WIFI_STATIC_IP_1, WIFI_STATIC_IP_2, WIFI_STATIC_IP_3);
    IPAddress gateway_ip(WIFI_STATIC_GW_0, WIFI_STATIC_GW_1, WIFI_STATIC_GW_2, WIFI_STATIC_GW_3);
    IPAddress subnet_mask(WIFI_STATIC_SUBNET_0, WIFI_STATIC_SUBNET_1, WIFI_STATIC_SUBNET_2, WIFI_STATIC_SUBNET_3);
    if (!WiFi.config(local_ip, gateway_ip, subnet_mask)) {
        Serial.println("[GATEWAY] Failed to apply static WiFi IP config");
    }

    // Scan to confirm target SSID is visible before attempting association
    Serial.printf("[GATEWAY] WiFi scanning for \"%s\"...\n", WIFI_SSID);
    int n = WiFi.scanNetworks();
    bool found = false;
    for (int i = 0; i < n; i++) {
        Serial.printf("[GATEWAY]   [%d] SSID=\"%s\" RSSI=%d ch=%d\n",
                      i, WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
        if (WiFi.SSID(i) == WIFI_SSID) found = true;
    }
    WiFi.scanDelete();
    if (!found) {
        Serial.printf("[GATEWAY] WiFi SSID \"%s\" not found in scan — connect will likely fail\n", WIFI_SSID);
    }

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
        delay(250);
    }
    wifi_connected = (WiFi.status() == WL_CONNECTED);
    if (wifi_connected) {
        Serial.printf("[GATEWAY] WiFi connected: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.printf("[GATEWAY] WiFi connect failed (status=%d) — will retry\n", (int)WiFi.status());
    }
}

void check_wifi_reconnect(uint32_t now_ms) {
    if (UPLINK_TRANSPORT_SERIAL) return;
    if (now_ms - last_wifi_check_ms < WIFI_RECONNECT_INTERVAL_MS) return;
    last_wifi_check_ms = now_ms;

    bool currently_up = (WiFi.status() == WL_CONNECTED);
    if (!currently_up) {
        if (wifi_connected) Serial.println("[GATEWAY] WiFi lost — reconnecting");
        wifi_connected = false;
        connect_wifi();
    } else {
        wifi_connected = true;
    }
}

// =============================================================================
//  Checksum
// =============================================================================

uint8_t calculate_checksum(const uint8_t* data, uint8_t len) {
    uint8_t cs = 0;
    for (uint8_t i = 0; i < len; i++) cs ^= data[i];
    return cs;
}

// =============================================================================
//  Packet → JSON helpers
// =============================================================================

// Reads a little-endian int32 from buf[offset]
static inline int32_t read_i32(const uint8_t* buf, uint8_t offset) {
    int32_t v;
    memcpy(&v, buf + offset, 4);
    return v;
}
static inline uint32_t read_u32(const uint8_t* buf, uint8_t offset) {
    uint32_t v;
    memcpy(&v, buf + offset, 4);
    return v;
}
static inline uint16_t read_u16(const uint8_t* buf, uint8_t offset) {
    uint16_t v;
    memcpy(&v, buf + offset, 2);
    return v;
}

// Build JSON for FRAME_GPS_UPDATE
// packet: [frame_type(1) car_id(1) timestamp(4) lat(4) lon(4) speed_cms(2) battery_pct(1) sat_count(1) cs(1)]
// The JSON "accuracy" field is still populated with LoRa RSSI (dBm) for dashboard signal quality.
String build_position_json(const uint8_t* p, int16_t lora_rssi_dbm = 32767) {
    bool gps_lock = (p[17] & 0x80) != 0;
    uint8_t sat_count = p[17] & 0x7F;
    JsonDocument doc;
    doc["type"]      = "position";
    doc["car_id"]    = p[1];
    uint8_t cls = (uint8_t)car_class_code[p[1]];
    if (is_valid_class_code(cls)) {
        doc["name"] = format_car_name(p[1]);
    }
    doc["timestamp"] = read_u32(p, 2);
    doc["lat"]       = read_i32(p, 6)  / 1e7;
    doc["lon"]       = read_i32(p, 10) / 1e7;
    doc["speed_cms"] = read_u16(p, 14);
    doc["accuracy"]  = (lora_rssi_dbm == 32767) ? (int)p[16] : (int)lora_rssi_dbm;
    doc["battery_pct"] = (int)p[16];
    doc["sat_count"] = sat_count;
    doc["gps_lock"]  = gps_lock;
    String out;
    serializeJson(doc, out);
    return out;
}

// Build JSON for FRAME_ALERT / FRAME_LAP_CROSSING / FRAME_REGISTER
String build_event_json(const uint8_t* p, uint8_t len) {
    JsonDocument doc;
    uint8_t frame = p[0];

    if (frame == FRAME_ALERT && len == PACKET_ALERT_LEN) {
        doc["type"]       = "alert";
        doc["car_id"]     = p[1];
        doc["timestamp"]  = read_u32(p, 2);
        doc["lat"]        = read_i32(p, 6)  / 1e7;
        doc["lon"]        = read_i32(p, 10) / 1e7;
        doc["alert_type"] = p[14];
    } else if (frame == FRAME_LAP_CROSSING && len == PACKET_LAP_LEN) {
        doc["type"]          = "lap";
        doc["car_id"]        = p[1];
        doc["timestamp"]     = read_u32(p, 2);
        doc["lat"]           = read_i32(p, 6)  / 1e7;
        doc["lon"]           = read_i32(p, 10) / 1e7;
        doc["crossing_type"] = p[14];
        doc["lap_number"]    = read_u16(p, 15);
    } else if (frame == FRAME_REGISTER && len == PACKET_REGISTER_LEN) {
        doc["type"]      = "register";
        doc["car_id"]    = p[1];
        doc["name"]      = format_car_name(p[1]);
        doc["timestamp"] = read_u32(p, 2);
        doc["lat"]       = read_i32(p, 6)  / 1e7;
        doc["lon"]       = read_i32(p, 10) / 1e7;
        doc["class_code"] = String((char)p[14]);
    } else {
        doc["type"]       = "unknown";
        doc["frame_type"] = frame;
        doc["len"]        = len;
    }
    String out;
    serializeJson(doc, out);
    return out;
}

// =============================================================================
//  HTTP helpers
// =============================================================================

bool http_post_json(const char* url, const String& json_body) {
    if (UPLINK_TRANSPORT_SERIAL) return false;
    if (!wifi_connected) return false;

    HTTPClient http;
    http.begin(url);
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");

    int code = http.POST(json_body);
    bool ok  = (code >= 200 && code < 300);

    if (DIAGNOSTICS_ENABLED) {
        if (ok) Serial.printf("[GATEWAY] POST %s → %d\n", url, code);
        else    Serial.printf("[GATEWAY] POST %s failed: %d\n", url, code);
    }

    http.end();
    return ok;
}

// =============================================================================
//  Register ACK — send FRAME_REGISTER_ACK back to a specific car
// =============================================================================

struct __attribute__((packed)) LoRaSyncPacket {
    uint8_t  frame_type;
    uint8_t  car_id;
    uint32_t server_timestamp;
    uint16_t config_version;
    int32_t  line_lat1, line_lon1;
    int32_t  line_lat2, line_lon2;
    uint16_t line_width_m;
    uint8_t  checksum;
};

static uint32_t current_server_time  = 0;   // refreshed from /api/sync
static uint16_t current_config_ver   = 0;
static int32_t  line_lat1 = 0, line_lon1 = 0;
static int32_t  line_lat2 = 0, line_lon2 = 0;
static uint16_t line_width_m = 0;

void send_sync_packet(uint8_t target_car_id, uint8_t frame_type) {
    LoRaSyncPacket pkt;
    pkt.frame_type        = frame_type;
    pkt.car_id            = target_car_id;
    pkt.server_timestamp  = (current_server_time > 0)
                            ? current_server_time
                            : (uint32_t)(millis() / 1000);
    pkt.config_version    = current_config_ver;
    pkt.line_lat1         = line_lat1;
    pkt.line_lon1         = line_lon1;
    pkt.line_lat2         = line_lat2;
    pkt.line_lon2         = line_lon2;
    pkt.line_width_m      = line_width_m;
    pkt.checksum          = calculate_checksum((uint8_t*)&pkt, PACKET_SYNC_LEN - 1);

    lora_listening = false;
    lora_rx_flag = false;
    int state = radio.transmit((uint8_t*)&pkt, PACKET_SYNC_LEN);
    if (state != RADIOLIB_ERR_NONE) {
        tx_sync_err++;
        if (DIAGNOSTICS_ENABLED) Serial.printf("[GATEWAY] Sync TX err %d\n", state);
    } else {
        tx_sync_ok++;
        if (frame_type == FRAME_REGISTER_ACK) register_acks_sent++;
        if (frame_type == FRAME_SYNC && target_car_id == 0xFF) sync_broadcasts_sent++;
        if (DIAGNOSTICS_ENABLED)
            Serial.printf("[GATEWAY] Sync sent to car %d (frame=0x%02X)\n", target_car_id, frame_type);
    }

    enter_lora_receive_mode();
}

bool ack_alert_control(uint8_t car_id, bool alert_active) {
    if (!wifi_connected) return false;

    HTTPClient http;
    char url[96];
    snprintf(url, sizeof(url), "http://%s:%d/api/control/alert-control-sent", SERVER_HOST, SERVER_PORT);
    http.begin(url);
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");

    JsonDocument doc;
    doc["car_id"] = car_id;
    doc["alert_active"] = alert_active;
    String body;
    serializeJson(doc, body);

    int code = http.POST(body);
    http.end();
    return code >= 200 && code < 300;
}

void send_alert_control(uint8_t target_car_id, bool alert_active) {
    LoRaAlertControl pkt;
    pkt.frame_type = FRAME_ALERT_CONTROL;
    pkt.car_id = target_car_id;
    pkt.server_timestamp = (current_server_time > 0)
                           ? current_server_time
                           : (uint32_t)(millis() / 1000);
    pkt.alert_active = alert_active ? 1 : 0;
    pkt.checksum = calculate_checksum((uint8_t*)&pkt, PACKET_ALERT_CONTROL_LEN - 1);

    lora_listening = false;
    lora_rx_flag = false;
    int state = radio.transmit((uint8_t*)&pkt, PACKET_ALERT_CONTROL_LEN);
    if (state != RADIOLIB_ERR_NONE) {
        tx_sync_err++;
        if (DIAGNOSTICS_ENABLED) Serial.printf("[GATEWAY] Alert control TX err %d car=%u state=%u\n", state, target_car_id, pkt.alert_active);
    } else if (DIAGNOSTICS_ENABLED) {
        tx_sync_ok++;
        Serial.printf("[GATEWAY] Alert control sent car=%u state=%u\n", target_car_id, pkt.alert_active);
    } else {
        tx_sync_ok++;
    }

    enter_lora_receive_mode();
}

void poll_pending_alert_controls(uint32_t now_ms) {
    if (UPLINK_TRANSPORT_SERIAL) return;
    if (!wifi_connected) return;
    if (now_ms - last_control_poll_ms < CONTROL_POLL_INTERVAL_MS) return;
    last_control_poll_ms = now_ms;

    HTTPClient http;
    char url[96];
    snprintf(url, sizeof(url), "http://%s:%d/api/control/pending-alert-controls", SERVER_HOST, SERVER_PORT);
    http.begin(url);
    http.setTimeout(HTTP_TIMEOUT_MS);

    int code = http.GET();
    if (code != 200) {
        http.end();
        return;
    }

    String body = http.getString();
    http.end();

    JsonDocument doc;
    if (deserializeJson(doc, body) != DeserializationError::Ok) return;

    JsonArray ctrls = doc["controls"].as<JsonArray>();
    for (JsonObject ctrl : ctrls) {
        uint8_t car_id = ctrl["car_id"] | 0;
        bool alert_active = ctrl["alert_active"] | false;
        if (car_id < 1 || car_id > 254) continue;

        fetch_server_sync();
        send_alert_control(car_id, alert_active);
        ack_alert_control(car_id, alert_active);
    }
}

// =============================================================================
//  Fetch time + line config from server
// =============================================================================

void fetch_server_sync() {
    if (UPLINK_TRANSPORT_SERIAL) return;
    if (!wifi_connected) return;

    HTTPClient http;
    char url[64];
    snprintf(url, sizeof(url), "http://%s:%d/api/sync", SERVER_HOST, SERVER_PORT);
    http.begin(url);
    http.setTimeout(HTTP_TIMEOUT_MS);

    int code = http.GET();
    if (code == 200) {
        String body = http.getString();
        JsonDocument doc;
        if (deserializeJson(doc, body) == DeserializationError::Ok) {
            current_server_time = doc["timestamp"]       | current_server_time;
            current_config_ver  = doc["config_version"]  | current_config_ver;
            line_lat1           = (int32_t)(doc["line_lat1"].as<float>() * 1e7);
            line_lon1           = (int32_t)(doc["line_lon1"].as<float>() * 1e7);
            line_lat2           = (int32_t)(doc["line_lat2"].as<float>() * 1e7);
            line_lon2           = (int32_t)(doc["line_lon2"].as<float>() * 1e7);
            line_width_m        = doc["line_width_m"] | line_width_m;
            if (DIAGNOSTICS_ENABLED)
                Serial.printf("[GATEWAY] Sync fetched: ts=%lu cfg_ver=%d\n",
                              (unsigned long)current_server_time, current_config_ver);
        }
    }
    http.end();
}

// =============================================================================
//  Process incoming LoRa packet
// =============================================================================

void process_lora_packet(const uint8_t* data, uint8_t len) {
    if (len < 3) return;

    uint8_t cs_rx   = data[len - 1];
    uint8_t cs_calc = calculate_checksum(data, len - 1);
    if (cs_rx != cs_calc) {
        if (DIAGNOSTICS_ENABLED)
            Serial.printf("[GATEWAY] Checksum fail rx=%02X calc=%02X\n", cs_rx, cs_calc);
        return;
    }

    uint8_t frame = data[0];
    int16_t rssi_dbm = (int16_t)lroundf(radio.getRSSI());
    if (DIAGNOSTICS_ENABLED)
        Serial.printf("[GATEWAY] RX frame=0x%02X car=%d len=%d RSSI=%.0f\n",
                      frame, data[1], len, (float)rssi_dbm);

    if (frame == FRAME_GPS_UPDATE && len == PACKET_GPS_UPDATE_LEN) {
        if (DIAGNOSTICS_ENABLED) {
            const uint8_t raw_batt = data[16];
            const bool gps_lock = (data[17] & 0x80) != 0;
            const uint8_t sats = data[17] & 0x7F;
            Serial.printf("[GATEWAY][BAT] car=%u raw_batt_byte=%u gps_lock=%u sats=%u rssi=%d\n",
                          (unsigned)data[1],
                          (unsigned)raw_batt,
                          gps_lock ? 1u : 0u,
                          (unsigned)sats,
                          (int)rssi_dbm);
        }
        String json = build_position_json(data, rssi_dbm);
        if (UPLINK_TRANSPORT_SERIAL) {
            uplink_send_json(json);
        } else if (!http_post_json(SERVER_POSITION_URL, json)) {
            ring_push(data, len);
        }
    } else if (frame == FRAME_REGISTER && len == PACKET_REGISTER_LEN) {
        if (is_valid_class_code(data[14])) {
            car_class_code[data[1]] = (char)data[14];
        }
        // Forward event to server then immediately send ACK back via LoRa
        String json = build_event_json(data, len);
        if (UPLINK_TRANSPORT_SERIAL) {
            uplink_send_json(json);
            // In serial-uplink mode there is no /api/sync fetch, but ACK is still required
            // so trackers can transition from REGISTERING to OPERATIONAL.
            send_sync_packet(data[1], FRAME_REGISTER_ACK);
        } else {
            http_post_json(SERVER_EVENT_URL, json);
            fetch_server_sync();  // refresh timestamp before ACK
            send_sync_packet(data[1], FRAME_REGISTER_ACK);
        }
    } else if ((frame == FRAME_ALERT       && len == PACKET_ALERT_LEN) ||
               (frame == FRAME_LAP_CROSSING && len == PACKET_LAP_LEN)) {
        String json = build_event_json(data, len);
        if (UPLINK_TRANSPORT_SERIAL) {
            uplink_send_json(json);
        } else if (!http_post_json(SERVER_EVENT_URL, json)) {
            ring_push(data, len);
        }
    } else if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[GATEWAY] Unknown frame 0x%02X len=%d\n", frame, len);
    }
}

// =============================================================================
//  Drain buffered packets after WiFi recovery
// =============================================================================

void drain_ring_buffer() {
    if (UPLINK_TRANSPORT_SERIAL) return;
    while (!ring_empty() && wifi_connected) {
        QueuedPacket* pkt = ring_peek();
        const uint8_t* data  = pkt->data;
        uint8_t        len   = pkt->len;
        uint8_t        frame = data[0];

        bool ok;
        if (frame == FRAME_GPS_UPDATE) {
            ok = http_post_json(SERVER_POSITION_URL, build_position_json(data));
        } else {
            ok = http_post_json(SERVER_EVENT_URL, build_event_json(data, len));
        }

        if (ok) ring_pop();
        else    break;  // server still unreachable; try again later
    }
}

// =============================================================================
//  Periodic sync broadcast
// =============================================================================

uint32_t last_sync_broadcast_ms = 0;

void maybe_broadcast_sync(uint32_t now_ms) {
    if (now_ms - last_sync_broadcast_ms < effective_sync_interval_ms) return;
    last_sync_broadcast_ms = now_ms;
    fetch_server_sync();
    send_sync_packet(0xFF, FRAME_SYNC);  // 0xFF = broadcast to all trackers
}

// =============================================================================
//  setup / loop
// =============================================================================

void setup() {
    Serial.begin(SERIAL_BAUD);
    delay(1000);
    Serial.println("\n\n=== Race Tracking — Gateway Node Booting ===");

    if (OTA_ENABLED) {
        pinMode(OTA_BOOT_HOLD_PIN, INPUT_PULLUP);
        if (should_enter_ota_mode_on_boot()) {
            if (start_ota_mode()) {
                Serial.println("[GATEWAY] OTA mode active; gateway forwarding paused until reboot");
                return;
            }
            Serial.println("[GATEWAY] OTA mode requested but WiFi unavailable; continuing normal boot");
        }
    }

    if (UPLINK_TRANSPORT_SERIAL) {
#if UPLINK_USE_USB_SERIAL
        Serial.printf("[GATEWAY] Serial uplink enabled over USB CDC/UART @ %d\n", SERIAL_BAUD);
#else
        uplinkSerial.begin(UPLINK_UART_BAUD, SERIAL_8N1, UPLINK_UART_RX_PIN, UPLINK_UART_TX_PIN);
        Serial.printf("[GATEWAY] Serial uplink enabled: UART2 TX=%d RX=%d baud=%d\n",
                      UPLINK_UART_TX_PIN, UPLINK_UART_RX_PIN, UPLINK_UART_BAUD);
#endif
    }

    init_lora();
    connect_wifi();
    fetch_server_sync();

    effective_sync_interval_ms = compute_budgeted_sync_interval_ms();
    if (DIAGNOSTICS_ENABLED) {
        Serial.printf("[GATEWAY] Sync interval: base=%lu ms effective=%lu ms nodes=%u util=%u/1000 x%u\n",
                      (unsigned long)SYNC_BROADCAST_INTERVAL_MS,
                      (unsigned long)effective_sync_interval_ms,
                      (unsigned)LINK_BUDGET_EXPECTED_NODES,
                      (unsigned)LINK_BUDGET_TARGET_CHANNEL_UTIL_PERMILLE,
                      (unsigned)LINK_BUDGET_INTERVAL_MULTIPLIER);
    }
}

void loop() {
    if (ota_mode_active) {
        handle_ota_mode_loop();
        return;
    }

    uint32_t now_ms = millis();

    check_wifi_reconnect(now_ms);
    drain_ring_buffer();
    if (!UPLINK_TRANSPORT_SERIAL) {
        poll_pending_alert_controls(now_ms);
        maybe_broadcast_sync(now_ms);
    }
    log_diagnostics(now_ms);

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
            if (DIAGNOSTICS_ENABLED) Serial.println("[GATEWAY] RX CRC mismatch");
        } else if (state == RADIOLIB_ERR_LORA_HEADER_DAMAGED) {
            rx_header_fail++;
            if (DIAGNOSTICS_ENABLED) Serial.println("[GATEWAY] RX header damaged");
        } else if (DIAGNOSTICS_ENABLED) {
            rx_other_errors++;
            Serial.printf("[GATEWAY] RX error %d\n", state);
        } else {
            rx_other_errors++;
        }
        enter_lora_receive_mode();
    }
}

bool should_enter_ota_mode_on_boot() {
    if (!OTA_ENABLED) return false;
    if (digitalRead(OTA_BOOT_HOLD_PIN) != LOW) return false;

    uint32_t start_ms = millis();
    while (millis() - start_ms < OTA_BOOT_HOLD_MS) {
        if (digitalRead(OTA_BOOT_HOLD_PIN) != LOW) return false;
        delay(10);
    }
    return true;
}

bool start_ota_mode() {
    if (strlen(WIFI_SSID) == 0) {
        Serial.println("[GATEWAY] OTA unavailable: WIFI_SSID empty");
        return false;
    }

    WiFi.disconnect(true);
    delay(100);
    WiFi.mode(WIFI_STA);
    delay(100);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("[GATEWAY] OTA WiFi connecting to: %s\n", WIFI_SSID);

    uint32_t start_ms = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start_ms < OTA_WIFI_CONNECT_TIMEOUT_MS) {
        delay(250);
    }
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[GATEWAY] OTA WiFi connect timeout (status=%d)\n", (int)WiFi.status());
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
        return false;
    }

    ArduinoOTA.setHostname(OTA_HOSTNAME);
    if (strlen(OTA_PASSWORD) > 0) {
        ArduinoOTA.setPassword(OTA_PASSWORD);
    }

    ArduinoOTA.onStart([]() {
        Serial.println("[GATEWAY][OTA] Start");
    });
    ArduinoOTA.onEnd([]() {
        Serial.println("[GATEWAY][OTA] End");
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("[GATEWAY][OTA] Error: %u\n", (unsigned)error);
    });
    ArduinoOTA.begin();

    ota_mode_active = true;
    Serial.printf("[GATEWAY][OTA] Ready: host=%s ip=%s\n", OTA_HOSTNAME, WiFi.localIP().toString().c_str());
    return true;
}

void handle_ota_mode_loop() {
    ArduinoOTA.handle();
    delay(2);
}
