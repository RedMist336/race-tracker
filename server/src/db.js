// Race Tracking — JSON-backed datastore
// Uses a local JSON file instead of SQLite so deployment works on minimal Node installs.

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'race-data.json');

function defaultState() {
  return {
    cars: {},
    positions: [],
    events: [],
    tracker_logs: [],
    active_alerts: [],
    config: {
      config_version: '0',
      line_lat1: '0',
      line_lon1: '0',
      line_lat2: '0',
      line_lon2: '0',
      line_width_m: '0'
    }
  };
}

let state = defaultState();

function load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      state = { ...defaultState(), ...parsed };
      state.config = { ...defaultState().config, ...(parsed.config || {}) };
      if (!state.cars) state.cars = {};
      if (!Array.isArray(state.positions)) state.positions = [];
      if (!Array.isArray(state.events)) state.events = [];
      if (!Array.isArray(state.tracker_logs)) state.tracker_logs = [];
      if (!Array.isArray(state.active_alerts)) state.active_alerts = [];
      return;
    }
  } catch (e) {
    console.warn('[db] failed loading JSON data, starting fresh:', e.message);
  }
  state = defaultState();
  save();
}

function save() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
}

load();

function upsertCar(car_id, name) {
  const now = Math.floor(Date.now() / 1000);
  const existing = state.cars[String(car_id)] || { car_id, name: '', driver_name: '', registered_at: now };

   const incomingName = name || existing.name || `Car ${car_id}`;
   const existingClassName = /^[CUMJS]\d+$/i.test(String(existing.name || ''));
   const incomingGeneric = /^Car\s+\d+$/i.test(String(incomingName || ''));

   const resolvedName = (existingClassName && incomingGeneric)
    ? existing.name
    : incomingName;

  state.cars[String(car_id)] = {
    ...existing,
    car_id,
    name: resolvedName,
    driver_name: String(existing.driver_name || ''),
    registered_at: now
  };
  save();
}

function setDriverName(car_id, driver_name) {
  const key = String(car_id);
  const existing = state.cars[key] || { car_id, name: `Car ${car_id}`, driver_name: '', registered_at: Math.floor(Date.now() / 1000) };
  state.cars[key] = {
    ...existing,
    car_id,
    driver_name: String(driver_name || '').trim()
  };
  save();
  return state.cars[key];
}

function insertPosition(row) {
  if (row.name) {
    upsertCar(row.car_id, row.name);
  } else if (!state.cars[String(row.car_id)]) {
    upsertCar(row.car_id, `Car ${row.car_id}`);
  }
  state.positions.push({
    ...row,
    battery_pct: Number.isFinite(Number(row.battery_pct))
      ? Math.max(0, Math.min(100, Math.round(Number(row.battery_pct))))
      : null,
    gps_lock: !!row.gps_lock,
    received_at: Math.floor(Date.now() / 1000)
  });

  if (state.positions.length > 20000) {
    state.positions = state.positions.slice(-15000);
  }
  save();
}

function insertEvent(row) {
  if (Number.isInteger(row.car_id) && row.car_id > 0) {
    // Only ensure the car record exists; do not overwrite the name set by upsertCar
    if (!state.cars[String(row.car_id)]) {
      upsertCar(row.car_id, `Car ${row.car_id}`);
    }
  }
  state.events.push({
    ...row,
    received_at: Math.floor(Date.now() / 1000)
  });

  if (state.events.length > 10000) {
    state.events = state.events.slice(-8000);
  }
  save();
}

function listCars() {
  const ids = new Set(Object.keys(state.cars).map((id) => parseInt(id, 10)).filter(Number.isInteger));
  for (const p of state.positions) ids.add(p.car_id);
  for (const e of state.events) ids.add(e.car_id);

  const cars = Array.from(ids)
    .filter((car_id) => Number.isInteger(car_id) && car_id > 0)
    .map((car_id) => state.cars[String(car_id)] || {
      car_id,
      name: `Car ${car_id}`,
      driver_name: '',
      registered_at: 0,
    })
    .sort((a, b) => a.car_id - b.car_id);

  return cars.map((car) => {
    let last = null;
    let prev = null;
    let lastValid = null;
    for (let i = state.positions.length - 1; i >= 0; i--) {
      const p = state.positions[i];
      if (p.car_id === car.car_id) {
        if (!last) {
          last = p;
        } else {
          prev = p;
        }
        if (!lastValid && p.gps_lock && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && !(Math.abs(Number(p.lat)) < 0.000001 && Math.abs(Number(p.lon)) < 0.000001)) {
          lastValid = p;
        }
        if (prev && lastValid) {
          break;
        }
      }
    }

    let expected_interval_ms = null;
    if (last && prev && Number.isFinite(last.timestamp) && Number.isFinite(prev.timestamp)) {
      const delta_ms = (last.timestamp - prev.timestamp) * 1000;
      if (delta_ms > 0) expected_interval_ms = delta_ms;
    }

    const posTs = last && Number.isFinite(last.timestamp) ? last.timestamp : 0;
    const posRx = last && Number.isFinite(last.received_at) ? last.received_at : 0;
    const validTs = lastValid && Number.isFinite(lastValid.timestamp) ? lastValid.timestamp : 0;
    const validRx = lastValid && Number.isFinite(lastValid.received_at) ? lastValid.received_at : 0;

    return {
      car_id: car.car_id,
      name: car.name,
      driver_name: String(car.driver_name || ''),
      registered_at: car.registered_at,
      lat: last ? last.lat : null,
      lon: last ? last.lon : null,
      speed_cms: last ? last.speed_cms : null,
      accuracy: last ? last.accuracy : null,
      sat_count: last ? last.sat_count : null,
      battery_pct: last ? last.battery_pct ?? null : null,
      gps_lock: last ? !!last.gps_lock : false,
      last_seen: posTs || null,
      last_received_at: posRx || null,
      last_valid_seen: validTs || null,
      last_valid_received_at: validRx || null,
      expected_interval_ms
    };
  });
}

function clearAllActiveAlerts() {
  if (!Array.isArray(state.active_alerts) || state.active_alerts.length === 0) return;
  state.active_alerts = [];
  save();
}

function positionHistory(car_id) {
  return state.positions
    .filter((p) => p.car_id === car_id)
    .slice(-500)
    .reverse()
    .map((p) => ({
      timestamp: p.timestamp,
      lat: p.lat,
      lon: p.lon,
      speed_cms: p.speed_cms,
      accuracy: p.accuracy,
      sat_count: p.sat_count,
      battery_pct: p.battery_pct ?? null,
      gps_lock: !!p.gps_lock
    }));
}

function getConfig() {
  return { ...state.config };
}

function setConfig(key, value) {
  state.config[key] = String(value);
  save();
}

function insertTrackerLog(row) {
  const nextId = (state.tracker_logs.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1);
  const points = Array.isArray(row.points) ? row.points : [];
  const log = {
    id: nextId,
    car_id: row.car_id,
    name: row.name || `Car ${row.car_id}`,
    log_date: row.log_date || 'unknown',
    file_name: row.file_name || `log-${nextId}.csv`,
    uploaded_at: Math.floor(Date.now() / 1000),
    row_count: points.length,
    points
  };

  state.tracker_logs.push(log);
  if (state.tracker_logs.length > 300) {
    state.tracker_logs = state.tracker_logs.slice(-250);
  }
  save();
  return log;
}

function listTrackerLogFiles(car_id = null) {
  const rows = state.tracker_logs
    .filter((r) => car_id == null || r.car_id === car_id)
    .map((r) => ({
      id: r.id,
      car_id: r.car_id,
      name: r.name,
      log_date: r.log_date,
      file_name: r.file_name,
      row_count: r.row_count,
      uploaded_at: r.uploaded_at
    }))
    .sort((a, b) => {
      if (a.car_id !== b.car_id) return a.car_id - b.car_id;
      if (a.log_date !== b.log_date) return String(b.log_date).localeCompare(String(a.log_date));
      return b.uploaded_at - a.uploaded_at;
    });
  return rows;
}

function getTrackerLogById(id) {
  return state.tracker_logs.find((r) => r.id === id) || null;
}

function deleteTrackerLogById(id) {
  const idx = state.tracker_logs.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const removed = state.tracker_logs[idx];
  state.tracker_logs.splice(idx, 1);
  save();
  return removed;
}

function upsertActiveAlert(alert) {
  const list = state.active_alerts.filter((a) => a.car_id !== alert.car_id);
  list.push({
    car_id: alert.car_id,
    name: alert.name || null,
    timestamp: alert.timestamp || 0,
    lat: Number.isFinite(Number(alert.lat)) ? Number(alert.lat) : null,
    lon: Number.isFinite(Number(alert.lon)) ? Number(alert.lon) : null,
    reason: alert.reason || 'driver',
    source_type: alert.source_type || 'alert'
  });
  state.active_alerts = list;
  save();
}

function removeActiveAlert(car_id) {
  const before = state.active_alerts.length;
  state.active_alerts = state.active_alerts.filter((a) => a.car_id !== car_id);
  if (state.active_alerts.length !== before) save();
}

function listActiveAlerts() {
  return (state.active_alerts || []).slice().sort((a, b) => a.car_id - b.car_id);
}

module.exports = {
  upsertCar,
  setDriverName,
  insertPosition,
  insertEvent,
  listCars,
  positionHistory,
  getConfig,
  setConfig,
  insertTrackerLog,
  listTrackerLogFiles,
  getTrackerLogById,
  deleteTrackerLogById,
  upsertActiveAlert,
  removeActiveAlert,
  listActiveAlerts,
  clearAllActiveAlerts
};
