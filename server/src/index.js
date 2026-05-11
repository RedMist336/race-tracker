// Race Tracking — Main server
// Node.js + Express + WebSocket
// Run:  node src/index.js   (or npm start)

'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const db      = require('./db');
const { registerTileRoute } = require('./tiles');

const PORT = process.env.PORT || 3000;

function envInt(name, fallback) {
  const raw = process.env[name];
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// =============================================================================
//  Middleware
// =============================================================================

app.use(express.json({ limit: '256kb' }));
const staticNoCache = {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
};
app.use('/lib', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), staticNoCache));
app.use(express.static(path.join(__dirname, '..', 'public'), staticNoCache));

app.use('/tiles', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : (forwardedFor || '')).toString().split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    const ua = (req.headers['user-agent'] || '').toString();
    const referer = (req.headers.referer || '').toString();
    const origin = (req.headers.origin || '').toString();
    const tileSource = (res.getHeader('X-Race-Tracker-Tile-Source') || '').toString();
    console.log(`[tiles] ${clientIp} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms src=${tileSource || '-'} ua="${ua}" referer="${referer}" origin="${origin}"`);
  });
  next();
});

// =============================================================================
//  WebSocket broadcast
// =============================================================================

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

const STATIONARY_ALERT_SECONDS = 180;
const STATIONARY_DISTANCE_METERS = 8;
const COMM_LOSS_INTERVAL_MS = 10 * 60 * 1000;
const COMM_LOSS_CHECK_INTERVAL_MS = 5 * 1000;
const AUTO_ALERT_CANCEL_MUTE_MS = 20 * 60 * 1000;
const GATEWAY_OFFLINE_MS = Math.max(10 * 1000, envInt('GATEWAY_OFFLINE_MS', 120 * 1000));
const GATEWAY_STATUS_BROADCAST_MS = 5 * 1000;
const SERIAL_GATEWAY_ENABLED = String(process.env.SERIAL_GATEWAY_ENABLED || '1') !== '0';
function detectSerialGatewayPort() {
  const byIdDir = '/dev/serial/by-id';
  try {
    const names = fs.readdirSync(byIdDir).sort();
    if (names.length > 0) {
      return path.join(byIdDir, names[0]);
    }
  } catch (_err) {
    // Ignore and continue with fallback probe list.
  }

  const candidates = ['/dev/ttyUSB0', '/dev/ttyACM0', '/dev/ttyS1', '/dev/ttyAMA0'];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return candidate;
    } catch (_err) {
      // Keep searching.
    }
  }

  return '/dev/ttyUSB0';
}

const SERIAL_GATEWAY_PORT = String(process.env.SERIAL_GATEWAY_PORT || detectSerialGatewayPort()).trim();
const SERIAL_GATEWAY_BAUD = envInt('SERIAL_GATEWAY_BAUD', 115200);
const SERIAL_GATEWAY_PREFIX = String(process.env.SERIAL_GATEWAY_PREFIX || 'RTJSON:');
const WHAT3WORDS_API_KEY = String(process.env.WHAT3WORDS_API_KEY || '').trim();
const WHAT3WORDS_LANGUAGE = String(process.env.WHAT3WORDS_LANGUAGE || 'en').trim() || 'en';
const WHAT3WORDS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SERVER_STARTED_AT_UNIX = Math.floor(Date.now() / 1000);
const W3W_OFFLINE_WORDS_A = ['amber','atlas','beacon','canyon','cedar','comet','coral','delta','ember','falcon','forest','frost','glacier','harbor','hazel','island'];
const W3W_OFFLINE_WORDS_B = ['anchor','bravo','copper','drift','engine','field','grove','haven','juniper','lagoon','maple','orbit','pilot','quartz','rocket','summit'];
const W3W_OFFLINE_WORDS_C = ['alpha','bison','crest','dawn','echo','flint','gale','helium','iris','jet','kilo','lumen','mesa','nova','onyx','ridge'];

let gatewayLastSeenMs = 0;
const what3wordsCache = new Map();
const startupConfig = db.getConfig();
let raceActive = String(startupConfig.race_active || '0') === '1';
let raceStartedAt = parseInt(String(startupConfig.race_started_at || '0'), 10);
if (!Number.isFinite(raceStartedAt) || raceStartedAt < 0) raceStartedAt = 0;
let raceElapsedSeconds = parseInt(String(startupConfig.race_elapsed_seconds || '0'), 10);
if (!Number.isFinite(raceElapsedSeconds) || raceElapsedSeconds < 0) raceElapsedSeconds = 0;

// car_id -> { car_id, name, timestamp, lat, lon, reason, source_type }
const activeAlerts = new Map();
// car_id -> desired state for tracker matrix alert mode
const pendingAlertControls = new Map();
// car_id -> movement monitor state
const movementState = new Map();
// car_id -> { reason -> mute_until_ms }
const autoAlertMuteUntil = new Map();

db.clearAllActiveAlerts();

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCoordsOrNull(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  if (Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) return null;
  return {
    lat: Number(latNum.toFixed(6)),
    lon: Number(lonNum.toFixed(6))
  };
}

async function convertToWhat3Words(lat, lon) {
  const coords = normalizeCoordsOrNull(lat, lon);
  if (!coords) {
    const err = new Error('invalid_coordinates');
    err.status = 400;
    throw err;
  }
  if (!WHAT3WORDS_API_KEY) {
    const err = new Error('what3words_not_configured');
    err.status = 503;
    throw err;
  }

  const key = `${coords.lat.toFixed(6)},${coords.lon.toFixed(6)}:${WHAT3WORDS_LANGUAGE}`;
  const cached = what3wordsCache.get(key);
  if (cached && (Date.now() - cached.ts) <= WHAT3WORDS_CACHE_TTL_MS) {
    return cached.value;
  }

  const url = new URL('https://api.what3words.com/v3/convert-to-3wa');
  url.searchParams.set('coordinates', `${coords.lat},${coords.lon}`);
  url.searchParams.set('key', WHAT3WORDS_API_KEY);
  url.searchParams.set('language', WHAT3WORDS_LANGUAGE);

  const response = await fetch(url, { method: 'GET' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !body.words) {
    const errCode = body?.error?.code || `what3words_http_${response.status}`;
    const err = new Error(errCode);
    err.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw err;
  }

  const result = {
    words: String(body.words),
    language: String(body.language || WHAT3WORDS_LANGUAGE),
    nearest_place: String(body.nearestPlace || ''),
    coordinates: {
      lat: Number(body.coordinates?.lat),
      lon: Number(body.coordinates?.lng)
    }
  };
  what3wordsCache.set(key, { ts: Date.now(), value: result });
  return result;
}

function fallbackEmergencyWords(lat, lon) {
  const coords = normalizeCoordsOrNull(lat, lon);
  if (!coords) return null;

  const latKey = Math.round((coords.lat + 90) * 1000);
  const lonKey = Math.round((coords.lon + 180) * 1000);
  const key = Math.abs((latKey * 1103515245 + lonKey * 12345) | 0);

  const w1 = W3W_OFFLINE_WORDS_A[key % W3W_OFFLINE_WORDS_A.length];
  const w2 = W3W_OFFLINE_WORDS_B[Math.floor(key / 17) % W3W_OFFLINE_WORDS_B.length];
  const w3 = W3W_OFFLINE_WORDS_C[Math.floor(key / 37) % W3W_OFFLINE_WORDS_C.length];
  return {
    words: `${w1}.${w2}.${w3}`,
    language: WHAT3WORDS_LANGUAGE,
    nearest_place: 'offline-estimate',
    offline_fallback: true,
    coordinates: {
      lat: coords.lat,
      lon: coords.lon
    }
  };
}

function parseTrackerCsv(csvText) {
  const points = [];
  const lines = String(csvText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return points;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 7) continue;

    const timestamp = parseInt(parts[0], 10);
    const device_ms = parseInt(parts[1], 10);
    const lat = Number(parts[2]);
    const lon = Number(parts[3]);
    const speed_cms = parseInt(parts[4], 10);
    const accuracy = parseInt(parts[5], 10);
    const sat_count = parseInt(parts[6], 10);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    points.push({
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      device_ms: Number.isFinite(device_ms) ? device_ms : 0,
      lat,
      lon,
      speed_cms: Number.isFinite(speed_cms) ? speed_cms : 0,
      accuracy: Number.isFinite(accuracy) ? accuracy : 0,
      sat_count: Number.isFinite(sat_count) ? sat_count : 0
    });
  }

  return points;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function listActiveAlerts() {
  return Array.from(activeAlerts.values()).sort((a, b) => a.car_id - b.car_id);
}

function listAutoAlertMutes(nowMs = Date.now()) {
  const rows = [];
  for (const [car_id, reasons] of autoAlertMuteUntil.entries()) {
    for (const [reason, mute_until_ms] of Object.entries(reasons || {})) {
      const until = Number(mute_until_ms || 0);
      if (until > nowMs) {
        rows.push({ car_id, reason, mute_until: Math.floor(until / 1000) });
      }
    }
  }
  return rows.sort((a, b) => a.car_id - b.car_id || String(a.reason).localeCompare(String(b.reason)));
}

function broadcastAutoAlertMutes() {
  broadcast({ type: 'auto_alert_mutes', mutes: listAutoAlertMutes() });
}

function hasEligibleGpsSinceStartup(car) {
  return Number(car?.last_valid_received_at || 0) >= SERVER_STARTED_AT_UNIX;
}

function raceStatePayload() {
  let elapsed = raceElapsedSeconds;
  if (raceActive && raceStartedAt > 0) {
    elapsed = Math.max(0, Math.floor(Date.now() / 1000) - raceStartedAt);
  }
  return {
    active: raceActive,
    started_at: raceStartedAt || null,
    elapsed_seconds: elapsed
  };
}

function broadcastRaceState() {
  broadcast({ type: 'race_state', race: raceStatePayload() });
}

function setRaceActive(nextActive) {
  const desired = !!nextActive;
  const nowTs = Math.floor(Date.now() / 1000);
  if (desired) {
    if (raceActive) {
      broadcastRaceState();
      return;
    }
    raceActive = true;
    raceStartedAt = nowTs;
    raceElapsedSeconds = 0;
  } else {
    if (!raceActive) {
      broadcastRaceState();
      return;
    }
    if (raceActive && raceStartedAt > 0) {
      raceElapsedSeconds = Math.max(0, nowTs - raceStartedAt);
    }
    raceActive = false;
    raceStartedAt = 0;
  }
  db.setConfig('race_active', raceActive ? '1' : '0');
  db.setConfig('race_started_at', String(raceStartedAt));
  db.setConfig('race_elapsed_seconds', String(raceElapsedSeconds));
  broadcastRaceState();
}

function raceDayStartUnix(startTs) {
  if (!Number.isFinite(Number(startTs)) || Number(startTs) <= 0) return 0;
  const d = new Date(Number(startTs) * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function enqueueAlertControl(car_id, alertActive) {
  pendingAlertControls.set(car_id, !!alertActive);
}

function setAutoAlertMute(car_id, reason, muteUntilMs) {
  if (!Number.isInteger(car_id) || car_id < 1) return;
  const key = String(reason || '').trim();
  if (!key) return;
  const existing = autoAlertMuteUntil.get(car_id) || {};
  existing[key] = Math.max(Number(existing[key] || 0), Number(muteUntilMs || 0));
  autoAlertMuteUntil.set(car_id, existing);
  broadcastAutoAlertMutes();
}

function isAutoAlertMuted(car_id, reason, nowMs = Date.now()) {
  const entry = autoAlertMuteUntil.get(car_id);
  if (!entry) return false;
  const until = Number(entry[String(reason || '').trim()] || 0);
  return until > nowMs;
}

function broadcastAlertState() {
  broadcast({ type: 'alert_state', alerts: listActiveAlerts() });
}

function monitorCommunicationLoss() {
  const nowTs = Math.floor(Date.now() / 1000);
  const thresholdSec = Math.ceil(COMM_LOSS_INTERVAL_MS / 1000);
  for (const car of db.listCars()) {
    if (!Number.isInteger(car.car_id) || car.car_id < 1) continue;
    const lastRx = Number(car.last_received_at || 0);
    const existing = activeAlerts.get(car.car_id) || null;
    if (!hasEligibleGpsSinceStartup(car)) {
      if (existing && existing.reason === 'lost_connection') {
        clearAlert(car.car_id, 'not_reported_race_day');
      }
      continue;
    }

    if (lastRx > 0 && (nowTs - lastRx) >= thresholdSec) {
      if (isAutoAlertMuted(car.car_id, 'lost_connection')) {
        continue;
      }
      if (!existing) {
        activateAlert(car.car_id, {
          name: car.name || null,
          timestamp: nowTs,
          lat: Number.isFinite(Number(car.lat)) ? Number(car.lat) : null,
          lon: Number.isFinite(Number(car.lon)) ? Number(car.lon) : null,
          reason: 'lost_connection',
          source_type: 'auto_comm_loss'
        });
        db.insertEvent({
          car_id: car.car_id,
          type: 'alert',
          timestamp: nowTs,
          lat: Number.isFinite(Number(car.lat)) ? Number(car.lat) : null,
          lon: Number.isFinite(Number(car.lon)) ? Number(car.lon) : null,
          data: JSON.stringify({ alert_type: 'LOST_CONNECTION', last_received_at: lastRx, threshold_seconds: thresholdSec })
        });
      }
      continue;
    }

    if (existing && existing.reason === 'lost_connection') {
      clearAlert(car.car_id, 'connection_restored');
      db.insertEvent({
        car_id: car.car_id,
        type: 'alert_clear',
        timestamp: nowTs,
        lat: null,
        lon: null,
        data: JSON.stringify({ clear_reason: 'CONNECTION_RESTORED' })
      });
    }
  }
}

function activateAlert(car_id, options = {}) {
  const car = db.listCars().find((row) => row.car_id === car_id) || null;
  if (!hasEligibleGpsSinceStartup(car)) {
    return;
  }
  const nowTs = Math.floor(Date.now() / 1000);
  const alert = {
    car_id,
    name: options.name || null,
    timestamp: Number.isFinite(Number(options.timestamp)) ? Math.floor(Number(options.timestamp)) : nowTs,
    lat: toNumberOrNull(options.lat),
    lon: toNumberOrNull(options.lon),
    reason: options.reason || 'driver',
    source_type: options.source_type || 'alert'
  };

  const existing = activeAlerts.get(car_id);
  const merged = { ...existing, ...alert };
  activeAlerts.set(car_id, merged);
  db.upsertActiveAlert(merged);
  enqueueAlertControl(car_id, true);

  broadcast({
    type: 'alert',
    car_id,
    name: alert.name,
    timestamp: alert.timestamp,
    lat: alert.lat,
    lon: alert.lon,
    alert_reason: alert.reason,
    source_type: alert.source_type
  });
  broadcastAlertState();
}

function clearAlert(car_id, reason = 'manual_cancel') {
  const prev = activeAlerts.get(car_id);
  activeAlerts.delete(car_id);
  db.removeActiveAlert(car_id);
  enqueueAlertControl(car_id, false);
  broadcast({ type: 'alert_cleared', car_id, clear_reason: reason });
  broadcastAlertState();
  return prev || null;
}

function updateStationaryMonitor({ car_id, name, timestamp, lat, lon }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const nowTs = Number.isFinite(Number(timestamp)) ? Math.floor(Number(timestamp)) : Math.floor(Date.now() / 1000);
  const prev = movementState.get(car_id) || {
    refLat: lat,
    refLon: lon,
    lastMovedTs: nowTs,
    stationaryAlertSent: false
  };

  const movedMeters = haversineMeters(prev.refLat, prev.refLon, lat, lon);
  if (movedMeters >= STATIONARY_DISTANCE_METERS) {
    prev.refLat = lat;
    prev.refLon = lon;
    prev.lastMovedTs = nowTs;
    prev.stationaryAlertSent = false;
    movementState.set(car_id, prev);
    return;
  }

  const stillFor = nowTs - prev.lastMovedTs;
  if (stillFor >= STATIONARY_ALERT_SECONDS && !prev.stationaryAlertSent) {
    if (isAutoAlertMuted(car_id, 'no_movement')) {
      movementState.set(car_id, prev);
      return;
    }
    prev.stationaryAlertSent = true;
    activateAlert(car_id, {
      name,
      timestamp: nowTs,
      lat,
      lon,
      reason: 'no_movement',
      source_type: 'auto_stationary'
    });
    db.insertEvent({
      car_id,
      type: 'alert',
      timestamp: nowTs,
      lat,
      lon,
      data: JSON.stringify({ alert_type: 'AUTO_NO_MOVEMENT', still_for_seconds: stillFor })
    });
  }

  movementState.set(car_id, prev);
}

function markGatewaySeen() {
  gatewayLastSeenMs = Date.now();
}

function gatewayStatusPayload() {
  const now = Date.now();
  const age_ms = gatewayLastSeenMs > 0 ? (now - gatewayLastSeenMs) : Number.POSITIVE_INFINITY;
  const connected = age_ms <= GATEWAY_OFFLINE_MS;
  return {
    connected,
    last_seen_ms_ago: Number.isFinite(age_ms) ? age_ms : null,
    offline_after_ms: GATEWAY_OFFLINE_MS
  };
}

wss.on('connection', (ws) => {
  // Send current car list on connect so new browser tabs populate immediately
  ws.send(JSON.stringify({
    type: 'snapshot',
    cars: db.listCars(),
    active_alerts: listActiveAlerts(),
    auto_alert_mutes: listAutoAlertMutes(),
    race: raceStatePayload(),
    server_started_at: SERVER_STARTED_AT_UNIX,
    gateway: gatewayStatusPayload(),
    comm_loss_interval_ms: COMM_LOSS_INTERVAL_MS,
    server_time: Math.floor(Date.now() / 1000)
  }));
});

function ingestPositionPayload(payload) {
  const { car_id, name, timestamp, lat, lon, speed_cms, accuracy, sat_count, gps_lock, battery_pct } = payload || {};

  if (!Number.isInteger(car_id) || car_id < 1 || car_id > 254) {
    const err = new Error('Invalid car_id');
    err.status = 400;
    throw err;
  }
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    const err = new Error('Invalid coordinates');
    err.status = 400;
    throw err;
  }

  const normalizedBatteryPct = Number.isFinite(Number(battery_pct))
    ? Math.max(0, Math.min(100, Math.round(Number(battery_pct))))
    : null;

  console.log(
    `[ingest] position car=${car_id} batt_in=${battery_pct} batt_norm=${normalizedBatteryPct} gps_lock=${!!gps_lock} sats=${sat_count || 0} lat=${lat} lon=${lon}`
  );

  db.insertPosition({ car_id, name: name || null, timestamp, lat, lon,
                      speed_cms: speed_cms || 0,
                      accuracy:  accuracy  || 0,
                      sat_count: sat_count || 0,
                      battery_pct: normalizedBatteryPct,
                      gps_lock: !!gps_lock });

  const lastValidReceivedAt = (gps_lock && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && !(Math.abs(Number(lat)) < 0.000001 && Math.abs(Number(lon)) < 0.000001))
    ? Math.floor(Date.now() / 1000)
    : null;

  markGatewaySeen();

  if (gps_lock) {
    updateStationaryMonitor({ car_id, name: name || null, timestamp, lat, lon });
  }

  const existingAlert = activeAlerts.get(car_id);
  if (existingAlert && existingAlert.reason === 'lost_connection') {
    clearAlert(car_id, 'connection_restored');
  }

  broadcast({ type: 'position', car_id, name: name || null, timestamp, lat, lon, speed_cms, accuracy, sat_count, battery_pct: normalizedBatteryPct, gps_lock: !!gps_lock, last_valid_received_at: lastValidReceivedAt });
}

function ingestEventPayload(payload) {
  const { type, car_id, name, timestamp, lat, lon, ...rest } = payload || {};

  if (!Number.isInteger(car_id) || car_id < 1 || car_id > 254) {
    const err = new Error('Invalid car_id');
    err.status = 400;
    throw err;
  }

  if (type === 'register') {
    let displayName = name || null;
    if (!displayName && typeof rest.class_code === 'string') {
      const cc = rest.class_code.trim().toUpperCase();
      if (/^[CUMJS]$/.test(cc)) displayName = `${cc}${car_id}`;
    }
    db.upsertCar(car_id, displayName || `Car ${car_id}`);
  }

  db.insertEvent({ car_id, type: type || 'unknown', timestamp: timestamp || 0,
                   lat: lat || null, lon: lon || null,
                   data: JSON.stringify(rest) });

  markGatewaySeen();

  let outName = name || null;
  if (!outName && type === 'register' && typeof rest.class_code === 'string') {
    const cc = rest.class_code.trim().toUpperCase();
    if (/^[CUMJS]$/.test(cc)) outName = `${cc}${car_id}`;
  }

  if (type === 'alert') {
    activateAlert(car_id, {
      name: outName,
      timestamp,
      lat,
      lon,
      reason: 'driver',
      source_type: 'tracker'
    });
  } else {
    broadcast({ type, car_id, name: outName, timestamp, lat, lon, ...rest });
  }
}

function ingestGatewayJson(payload, source = 'serial') {
  if (!payload || typeof payload !== 'object') {
    const err = new Error('payload must be an object');
    err.status = 400;
    throw err;
  }

  if (payload.type === 'position') {
    ingestPositionPayload(payload);
  } else {
    ingestEventPayload(payload);
  }

  if (source === 'serial') {
    const t = String(payload.type || 'unknown');
    const carId = Number(payload.car_id || 0);
    console.log(`[serial] ingested type=${t} car=${carId}`);
  }
}

// =============================================================================
//  REST API
// =============================================================================

// POST /api/position — called by gateway for every GPS update
app.post('/api/position', (req, res) => {
  try {
    ingestPositionPayload(req.body);
    res.json({ ok: true });
  } catch (err) {
    const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 400;
    res.status(status).json({ error: String(err?.message || 'invalid_position_payload') });
  }
});

// POST /api/event — called by gateway for register / alert / lap packets
app.post('/api/event', (req, res) => {
  try {
    ingestEventPayload(req.body);
    res.json({ ok: true });
  } catch (err) {
    const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 400;
    res.status(status).json({ error: String(err?.message || 'invalid_event_payload') });
  }
});

app.post('/api/alert/cancel', (req, res) => {
  const car_id = parseInt(req.body?.car_id, 10);
  if (!Number.isInteger(car_id) || car_id < 1 || car_id > 254) {
    return res.status(400).json({ error: 'Invalid car_id' });
  }

  const cleared = clearAlert(car_id, 'manual_cancel');
  const monitor = movementState.get(car_id);
  const muted_reasons = [];
  const nowMs = Date.now();

  if (cleared && (cleared.reason === 'no_movement' || cleared.reason === 'lost_connection')) {
    const muteUntilMs = nowMs + AUTO_ALERT_CANCEL_MUTE_MS;
    setAutoAlertMute(car_id, cleared.reason, muteUntilMs);
    muted_reasons.push({ reason: cleared.reason, mute_until: Math.floor(muteUntilMs / 1000) });
  }

  if (monitor && cleared && cleared.reason === 'no_movement') {
    monitor.stationaryAlertSent = false;
    movementState.set(car_id, monitor);
  }

  db.insertEvent({
    car_id,
    type: 'alert_cancel',
    timestamp: Math.floor(Date.now() / 1000),
    lat: null,
    lon: null,
    data: JSON.stringify({ reason: 'manual_cancel', had_active_alert: !!cleared, muted_reasons })
  });

  broadcastAutoAlertMutes();
  res.json({ ok: true, muted_reasons, active_alerts: listActiveAlerts(), auto_alert_mutes: listAutoAlertMutes() });
});

app.get('/api/control/pending-alert-controls', (_req, res) => {
  // Gateway polls this endpoint continuously; treat that as liveness.
  markGatewaySeen();
  const controls = Array.from(pendingAlertControls.entries())
    .map(([car_id, alert_active]) => ({ car_id, alert_active }))
    .sort((a, b) => a.car_id - b.car_id);
  res.json({ controls });
});

app.post('/api/control/alert-control-sent', (req, res) => {
  markGatewaySeen();
  const car_id = parseInt(req.body?.car_id, 10);
  const alert_active = !!req.body?.alert_active;
  if (!Number.isInteger(car_id) || car_id < 1 || car_id > 254) {
    return res.status(400).json({ error: 'Invalid car_id' });
  }

  if (pendingAlertControls.has(car_id) && pendingAlertControls.get(car_id) === alert_active) {
    pendingAlertControls.delete(car_id);
  }
  res.json({ ok: true });
});

// GET /api/cars — list all registered cars with last known position
app.get('/api/cars', (_req, res) => {
  res.json(db.listCars());
});

app.post('/api/cars/:car_id/driver', (req, res) => {
  const car_id = parseInt(req.params.car_id, 10);
  if (!Number.isInteger(car_id) || car_id < 1 || car_id > 254) {
    return res.status(400).json({ error: 'Invalid car_id' });
  }
  const driver_name = String(req.body?.driver_name || '').trim();
  if (driver_name.length > 80) {
    return res.status(400).json({ error: 'driver_name too long' });
  }
  const updated = db.setDriverName(car_id, driver_name);
  broadcast({ type: 'driver_name_updated', car_id, driver_name: updated.driver_name || '' });
  res.json({ ok: true, car_id, driver_name: updated.driver_name || '' });
});

app.get('/api/race-state', (_req, res) => {
  res.json(raceStatePayload());
});

app.post('/api/race-state', (req, res) => {
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ error: 'active boolean required' });
  }
  setRaceActive(req.body.active);
  res.json({ ok: true, race: raceStatePayload() });
});

app.post('/api/admin/shutdown', (_req, res) => {
  res.json({ ok: true, shutting_down: true });
  setTimeout(() => {
    execFile('sudo', ['-n', '/sbin/shutdown', '-h', 'now'], (error) => {
      if (error) {
        console.error('[server] shutdown command failed:', error.message);
      }
    });
  }, 250);
});

app.get('/api/what3words', async (req, res) => {
  const coords = normalizeCoordsOrNull(req.query?.lat, req.query?.lon);
  if (!coords) return res.status(400).json({ error: 'invalid_coordinates' });

  try {
    const result = await convertToWhat3Words(coords.lat, coords.lon);
    return res.json(result);
  } catch (err) {
    const fallback = fallbackEmergencyWords(coords.lat, coords.lon);
    if (fallback) {
      return res.json(fallback);
    }
    const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 502;
    const error = String(err?.message || 'what3words_lookup_failed');
    return res.status(status).json({ error });
  }
});

// GET /api/history/:car_id — last 500 positions for a car
app.get('/api/history/:car_id', (req, res) => {
  const car_id = parseInt(req.params.car_id, 10);
  if (!Number.isInteger(car_id)) return res.status(400).json({ error: 'Invalid car_id' });
  res.json(db.positionHistory(car_id));
});

// GET /api/sync — gateway fetches this to get current server time + line config
app.get('/api/sync', (_req, res) => {
  // Gateway fetches sync periodically even when no tracker packets are flowing.
  markGatewaySeen();
  const cfg = db.getConfig();
  res.json({
    timestamp:      Math.floor(Date.now() / 1000),
    config_version: parseInt(cfg.config_version, 10),
    line_lat1:      parseFloat(cfg.line_lat1),
    line_lon1:      parseFloat(cfg.line_lon1),
    line_lat2:      parseFloat(cfg.line_lat2),
    line_lon2:      parseFloat(cfg.line_lon2),
    line_width_m:   parseInt(cfg.line_width_m, 10),
  });
});

// PUT /api/config/line — set start/stop line from dashboard
app.put('/api/config/line', (req, res) => {
  const { lat1, lon1, lat2, lon2, width_m } = req.body;
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'lat1/lon1/lat2/lon2 required as numbers' });
  }
  db.setConfig('line_lat1',   lat1);
  db.setConfig('line_lon1',   lon1);
  db.setConfig('line_lat2',   lat2);
  db.setConfig('line_lon2',   lon2);
  db.setConfig('line_width_m', width_m || 10);

  const ver = parseInt(db.getConfig().config_version, 10) + 1;
  db.setConfig('config_version', ver);

  broadcast({ type: 'config_updated', config_version: ver });
  res.json({ ok: true, config_version: ver });
});

// POST /api/tracker-logs — receive CSV GPS log upload from tracker WiFi button hold
app.post('/api/tracker-logs', express.text({ type: 'text/csv', limit: '4mb' }), (req, res) => {
  const car_id  = parseInt(req.headers['x-tracker-id']   || '0', 10);
  const name    = req.headers['x-tracker-name'] || `Car ${car_id}`;
  const logDate = req.headers['x-log-date']     || 'unknown';
  const fileName = req.headers['x-log-file']    || `log-${Date.now()}.csv`;

  if (!car_id) return res.status(400).json({ error: 'Missing X-Tracker-Id header' });

  const points = parseTrackerCsv(req.body);
  const saved = db.insertTrackerLog({
    car_id,
    name,
    log_date: String(logDate),
    file_name: String(fileName),
    points
  });

  console.log(`[server] GPS log received from car ${car_id} (${name}) date=${logDate} file=${fileName} rows=${saved.row_count} size=${req.body.length}`);
  res.json({ ok: true, log_id: saved.id, rows: saved.row_count });
});

app.get('/api/tracker-logs/files', (req, res) => {
  const car_id = req.query.car_id != null ? parseInt(req.query.car_id, 10) : null;
  if (req.query.car_id != null && !Number.isInteger(car_id)) {
    return res.status(400).json({ error: 'Invalid car_id' });
  }
  res.json(db.listTrackerLogFiles(car_id));
});

app.get('/api/tracker-logs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const log = db.getTrackerLogById(id);
  if (!log) return res.status(404).json({ error: 'Log not found' });
  res.json(log);
});

app.delete('/api/tracker-logs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const removed = db.deleteTrackerLogById(id);
  if (!removed) return res.status(404).json({ error: 'Log not found' });
  res.json({ ok: true, deleted: { id: removed.id, file_name: removed.file_name } });
});

// =============================================================================
//  Tile serving
// =============================================================================

registerTileRoute(app);

setInterval(monitorCommunicationLoss, COMM_LOSS_CHECK_INTERVAL_MS);

setInterval(() => {
  broadcast({ type: 'gateway_status', gateway: gatewayStatusPayload() });
}, GATEWAY_STATUS_BROADCAST_MS);

function startSerialGatewayIngest() {
  if (!SERIAL_GATEWAY_ENABLED) {
    console.log('[serial] gateway ingest disabled (SERIAL_GATEWAY_ENABLED=0)');
    return;
  }

  let SerialPort;
  let ReadlineParser;
  try {
    ({ SerialPort } = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
  } catch (err) {
    console.warn(`[serial] serial packages unavailable: ${String(err?.message || err)}`);
    console.warn('[serial] install with: npm install serialport @serialport/parser-readline');
    return;
  }

  const port = new SerialPort({
    path: SERIAL_GATEWAY_PORT,
    baudRate: SERIAL_GATEWAY_BAUD,
    autoOpen: false
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('error', (err) => {
    console.error(`[serial] port error: ${String(err?.message || err)}`);
  });

  parser.on('data', (line) => {
    const raw = String(line || '').trim();
    if (!raw.startsWith(SERIAL_GATEWAY_PREFIX)) return;

    const jsonPart = raw.slice(SERIAL_GATEWAY_PREFIX.length).trim();
    if (!jsonPart) return;

    try {
      const payload = JSON.parse(jsonPart);
      ingestGatewayJson(payload, 'serial');
    } catch (err) {
      console.warn(`[serial] dropped invalid payload: ${String(err?.message || err)}`);
    }
  });

  port.open((err) => {
    if (err) {
      console.error(`[serial] open failed ${SERIAL_GATEWAY_PORT} @ ${SERIAL_GATEWAY_BAUD}: ${String(err.message || err)}`);
      return;
    }
    console.log(`[serial] listening on ${SERIAL_GATEWAY_PORT} @ ${SERIAL_GATEWAY_BAUD}`);
  });
}

// =============================================================================
//  Start
// =============================================================================

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Race Tracking server running on port ${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}`);
  startSerialGatewayIngest();
});
