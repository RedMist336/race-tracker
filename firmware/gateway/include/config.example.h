// Race Tracking — Gateway Node Configuration Template
// Hardware: TTGO TBeam v1.2
//
// INSTRUCTIONS:
// 1. Copy this file to config.h
// 2. Edit the values below (especially WIFI_SSID, WIFI_PASSWORD, SERVER_HOST)
// 3. DO NOT commit config.h to version control
// 4. Compile and flash to device

#ifndef GATEWAY_CONFIG_H
#define GATEWAY_CONFIG_H

// =============================================================================
//  UPLINK MODE — Choose one transport to send GPS data to the server
// =============================================================================

// Serial uplink: gateway transmits JSON over USB CDC serial
#define UPLINK_TRANSPORT_SERIAL 1
#define UPLINK_USE_USB_SERIAL   1   // use USB CDC, not UART2
#define UPLINK_JSON_PREFIX      "RTJSON:"

// (WiFi uplink is also supported; uncomment UPLINK_TRANSPORT_WIFI for direct server connection)
// #define UPLINK_TRANSPORT_WIFI 1
// #define UPLINK_WIFI_POST_URL "http://192.168.0.1:3000/api/position"

// =============================================================================
//  WIFI CONFIGURATION — Race network credentials
// =============================================================================
// ⚠️  SECURITY WARNING: Update these values with your network credentials
// These should NOT be committed to version control

#define WIFI_SSID               "YOUR_WIFI_SSID"
#define WIFI_PASSWORD           "YOUR_WIFI_PASSWORD"
#define WIFI_CONNECT_TIMEOUT_MS 15000
#define WIFI_RECONNECT_INTERVAL_MS 10000

// =============================================================================
//  OTA UPDATES — Maintenance mode entry
// =============================================================================
// Hold BOOT button during power-up for 3 seconds to enter OTA mode

#define OTA_ENABLED                 1
#define OTA_BOOT_HOLD_PIN           0
#define OTA_BOOT_HOLD_MS            3000
#define OTA_WIFI_CONNECT_TIMEOUT_MS 15000
#define OTA_HOSTNAME                "race-gateway"
#define OTA_PASSWORD                ""

// =============================================================================
//  STATIC IP CONFIGURATION — Gateway must have fixed IP on race WiFi
// =============================================================================

#define WIFI_STATIC_IP_0 192
#define WIFI_STATIC_IP_1 168
#define WIFI_STATIC_IP_2 0
#define WIFI_STATIC_IP_3 2

#define WIFI_STATIC_GW_0 192
#define WIFI_STATIC_GW_1 168
#define WIFI_STATIC_GW_2 0
#define WIFI_STATIC_GW_3 254

#define WIFI_STATIC_SUBNET_0 255
#define WIFI_STATIC_SUBNET_1 255
#define WIFI_STATIC_SUBNET_2 255
#define WIFI_STATIC_SUBNET_3 0

// =============================================================================
//  SERVER CONFIGURATION
// =============================================================================

// IP/hostname of the Node.js server that receives GPS data
#define SERVER_HOST "192.168.0.1"
#define SERVER_PORT 3000

// =============================================================================
//  LORA RF PARAMETERS — must match tracker configuration exactly
// =============================================================================

#define LORA_FREQUENCY        915.2f   // MHz — AU915 default
#define LORA_BANDWIDTH        125.0f   // kHz
#define LORA_SPREADING_FACTOR 7        // 7–12 (higher = longer range, lower = faster)
#define LORA_CODING_RATE      5        // 4/5 … 4/8
#define LORA_TX_POWER         14       // dBm
#define LORA_SYNC_WORD        0x34     // private network
#define LORA_CRC_ENABLED      true
#define LORA_PREAMBLE_LEN     8

// =============================================================================
//  GATEWAY UPLINK PERFORMANCE TUNING
// =============================================================================

#define LORA_RX_BUFFER_SIZE     256     // size of RX packet buffer
#define LORA_RX_TIMEOUT_MS      5000    // RX idle timeout
#define MAX_CONCURRENT_UPLOADS  5       // limit simultaneous WiFi uploads

#endif // GATEWAY_CONFIG_H
