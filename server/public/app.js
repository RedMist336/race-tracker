'use strict';

// =============================================================================
//  Map setup
// =============================================================================

const DEFAULT_MAP_CENTER = [-43.53, 172.64]; // Christchurch region (inside South Island tiles)
const DEFAULT_MAP_ZOOM = 8;
const DEFAULT_INTERACTION_MAX_ZOOM = 24;

const map = L.map('map', { zoomControl: true, minZoom: 7 }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const TILE_NONBLANK_MIN_BYTES = 103;
const COURSE_VIEW_WIDTH_M = 100;
const COURSE_VIEW_HEIGHT_M = 50;
const AUTO_FOCUS_MAX_ZOOM = 15;
const FALLBACK_NATIVE_MAX_ZOOM = 22;
const FALLBACK_NATIVE_MAX_ZOOM_UPSTREAM = 22;

function metersToLatLngDelta(centerLatDeg, widthM, heightM) {
  const metersPerDegLat = 111320;
  const cosLat = Math.max(0.01, Math.cos(centerLatDeg * Math.PI / 180));
  const metersPerDegLon = metersPerDegLat * cosLat;
  return {
    dLat: (heightM / 2) / metersPerDegLat,
    dLon: (widthM / 2) / metersPerDegLon,
  };
}

function fitShortCourseWindow(lat, lon) {
  const d = metersToLatLngDelta(lat, COURSE_VIEW_WIDTH_M, COURSE_VIEW_HEIGHT_M);
  const sw = [lat - d.dLat, lon - d.dLon];
  const ne = [lat + d.dLat, lon + d.dLon];
  map.fitBounds([sw, ne], {
    padding: [0, 0],
    animate: false,
    maxZoom: AUTO_FOCUS_MAX_ZOOM,
  });
}

function hasRenderableCoords(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return false;
  if (Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) return false;
  // Treat 0,0 sentinel/no-fix values as non-renderable to avoid panning into blank ocean tiles.
  if (Math.abs(latNum) < 0.000001 && Math.abs(lonNum) < 0.000001) return false;
  return true;
}

async function addBestAvailableTileLayer() {
  let meta = null;
  try {
    const resp = await fetch('/tiles/meta', { cache: 'no-store' });
    meta = resp.ok ? await resp.json() : null;

    if (meta && meta.poisoned && meta.mode !== 'upstream') {
      console.warn('[map] Local MBTiles is poisoned with blocked tile imagery.');
      const el = document.getElementById('map');
      if (el) {
        el.insertAdjacentHTML('beforeend',
          '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(30,30,30,0.55);color:#fff;font-size:14px;padding:16px;text-align:center;z-index:9999;pointer-events:none;">' +
          'Offline map dataset is flagged invalid; serving tiles anyway. Regenerate map.mbtiles from a compliant source when possible.</div>');
      }
    }

    if (meta && !meta.available) {
      console.warn('[map] Tile backend unavailable:', meta.unavailable_reason || 'unknown reason');
      const el = document.getElementById('map');
      if (el) {
        el.insertAdjacentHTML('beforeend',
          '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(30,30,30,0.78);color:#fff;font-size:14px;padding:16px;text-align:center;z-index:9999;pointer-events:none;">' +
          `Offline map unavailable: ${(meta.unavailable_reason || 'unknown tile backend error')}</div>`);
      }
    }

    const cacheBustToken = `t=${Date.now()}`;
    const tileUrl = `${location.origin}/tiles/{z}/{x}/{y}?${cacheBustToken}`;
    const fallbackNativeMaxZoom = (meta && meta.mode === 'upstream')
      ? FALLBACK_NATIVE_MAX_ZOOM_UPSTREAM
      : FALLBACK_NATIVE_MAX_ZOOM;
    const metaMaxZoom = Number(meta && meta.maxzoom);
    const metaMinZoom = Number(meta && meta.minzoom);
    const minNativeZoom = Number.isFinite(metaMinZoom) ? metaMinZoom : 7;
    const maxNativeZoom = Number.isFinite(metaMaxZoom)
      ? Math.max(minNativeZoom, metaMaxZoom)
      : fallbackNativeMaxZoom;
    const interactionMaxZoom = Math.max(DEFAULT_INTERACTION_MAX_ZOOM, maxNativeZoom);
    map.setMaxZoom(interactionMaxZoom);

    if (!meta || !meta.available) {
      console.warn('[map] /tiles/meta unavailable; attaching /tiles layer anyway.');
    }

    const layer = L.tileLayer(tileUrl, {
      attribution: 'Map data © OpenStreetMap contributors',
      minZoom: 7,
      maxZoom: interactionMaxZoom,
      minNativeZoom,
      maxNativeZoom,
      tileSize: 256,
      errorTileUrl: BLANK_TILE,
      opacity: 1
    }).addTo(map);

    layer.on('tileerror', (e) => {
      const z = e?.coords?.z;
      const x = e?.coords?.x;
      const y = e?.coords?.y;
      const actualUrl = e?.tile?.src || tileUrl;
      console.warn(`[map] tile load failed z=${z} x=${x} y=${y} url=${actualUrl}`);
    });

    const minz = Number.isFinite(metaMinZoom) ? metaMinZoom : '?';
    const maxz = Number.isFinite(metaMaxZoom) ? metaMaxZoom : '?';
    console.log(`[map] Tile layer attached (z${minz}-z${maxz}, maxNative=${maxNativeZoom}) url=${tileUrl}`);
  } catch (e) {
    console.warn('[map] /tiles/meta check failed; attaching /tiles layer with defaults:', e);
    const cacheBustToken = `t=${Date.now()}`;
    const tileUrl = `${location.origin}/tiles/{z}/{x}/{y}?${cacheBustToken}`;
    map.setMaxZoom(DEFAULT_INTERACTION_MAX_ZOOM);
    L.tileLayer(tileUrl, {
      attribution: 'Map data © OpenStreetMap contributors',
      minZoom: 7,
      maxZoom: DEFAULT_INTERACTION_MAX_ZOOM,
      minNativeZoom: 7,
      maxNativeZoom: FALLBACK_NATIVE_MAX_ZOOM,
      tileSize: 256,
      errorTileUrl: BLANK_TILE,
      opacity: 1
    }).addTo(map);
  }
}

addBestAvailableTileLayer();

// =============================================================================
//  Car state
// =============================================================================

// car_id → { marker, display_name, lat, lon, speed_cms, accuracy, sat_count, battery_pct, last_seen, expected_interval_ms, last_packet_ts, card }
const cars = {};

const DEFAULT_REPORT_INTERVAL_MS = 103_000;
const WHAT3WORDS_LOOKUP_TIMEOUT_MS = 6000;
let raceActive = false;
let raceStartedAt = null;
let raceElapsedSeconds = 0;
let serverStartedAtUnix = Math.floor(Date.now() / 1000);
const autoAlertMutes = new Map();

function formatDisplayName(nodeName, driverName) {
  const node = String(nodeName || '').trim();
  const driver = String(driverName || '').trim();
  if (!node) return driver || 'Unknown';
  if (!driver) return node;
  return `${node} — ${driver}`;
}

function alertReasonLabel(reason) {
  const key = String(reason || '').trim().toLowerCase();
  if (key === 'driver') return 'Driver Triggered';
  if (key === 'lost_connection') return 'Lost Connection';
  if (key === 'no_movement') return 'Zero Speed';
  if (key === 'connection_restored') return 'Connection Restored';
  if (!key) return 'Unknown';
  return key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function raceDayStartUnix(startTs) {
  if (!Number.isFinite(Number(startTs)) || Number(startTs) <= 0) return 0;
  const d = new Date(Number(startTs) * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function formatRaceHms(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatMuteRemaining(untilUnix) {
  const remaining = Math.max(0, Number(untilUnix || 0) - Math.floor(Date.now() / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function setAutoAlertMutes(mutes) {
  autoAlertMutes.clear();
  for (const mute of (mutes || [])) {
    const carId = Number(mute?.car_id);
    const reason = String(mute?.reason || '').trim();
    const until = Number(mute?.mute_until || 0);
    if (!Number.isInteger(carId) || carId < 1 || !reason || until <= 0) continue;
    const existing = autoAlertMutes.get(carId) || {};
    existing[reason] = until;
    autoAlertMutes.set(carId, existing);
  }
}

function renderMuteStatus(car_id) {
  const el = document.getElementById(`mute-status-${car_id}`);
  if (!el) return;
  const reasonMap = autoAlertMutes.get(Number(car_id)) || {};
  const active = Object.entries(reasonMap)
    .filter(([, until]) => Number(until) > Math.floor(Date.now() / 1000))
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (active.length === 0) {
    el.textContent = 'Mute: -';
    return;
  }
  el.textContent = active
    .map(([reason, until]) => `${alertReasonLabel(reason)} muted ${formatMuteRemaining(until)}`)
    .join(' | ');
}

function carColor(car_id) {
  const palette = ['#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa',
                   '#00acc1','#d81b60','#6d4c41','#546e7a','#ffb300'];
  return palette[car_id % palette.length];
}

function makeIcon(car_id, size = 28, colorOverride = null) {
  const color = colorOverride || carColor(car_id);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="13" fill="${color}" stroke="#fff" stroke-width="2"/>
    <text x="14" y="19" text-anchor="middle" font-size="12" font-family="sans-serif"
          font-weight="bold" fill="#fff">${car_id}</text>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const what3wordsLookupCache = new Map();

function emergencyW3wLabel(words) {
  return `Emergency W3W: ${words}`;
}

function setEmergencyW3wText(car_id, text) {
  const el = document.getElementById(`w3w-${car_id}`);
  if (el) el.textContent = text;
}

function resetEmergencyW3w(car_id) {
  setEmergencyW3wText(car_id, 'Emergency W3W: -');
}

async function lookupEmergencyW3w(car_id, lat, lon) {
  const c = cars[car_id];
  if (!c) return;

  if (!hasRenderableCoords(lat, lon)) {
    setEmergencyW3wText(car_id, 'Emergency W3W: no GPS fix');
    return;
  }

  const latNum = Number(lat);
  const lonNum = Number(lon);
  const key = `${latNum.toFixed(6)},${lonNum.toFixed(6)}`;
  c.w3w_lookup_token = (c.w3w_lookup_token || 0) + 1;
  const token = c.w3w_lookup_token;
  setEmergencyW3wText(car_id, 'Emergency W3W: resolving...');

  let lookupPromise = what3wordsLookupCache.get(key);
  if (!lookupPromise) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHAT3WORDS_LOOKUP_TIMEOUT_MS);
    lookupPromise = fetch(`/api/what3words?lat=${encodeURIComponent(latNum)}&lon=${encodeURIComponent(lonNum)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (resp) => {
        const body = await resp.json().catch(() => null);
        if (!resp.ok) {
          const err = new Error(String(body?.error || `http_${resp.status}`));
          err.status = resp.status;
          throw err;
        }
        return body;
      })
      .finally(() => clearTimeout(timeout));
    what3wordsLookupCache.set(key, lookupPromise);
  }

  try {
    const result = await lookupPromise;
    if (c.w3w_lookup_token !== token) return;
    if (result && typeof result.words === 'string' && result.words.length > 0) {
      setEmergencyW3wText(car_id, emergencyW3wLabel(result.words));
      return;
    }
    setEmergencyW3wText(car_id, 'Emergency W3W: unavailable');
  } catch (err) {
    const msg = String(err?.message || 'lookup_failed');
    if (msg.includes('not_configured')) {
      setEmergencyW3wText(car_id, 'Emergency W3W: key not configured');
      return;
    }
    if (c.w3w_lookup_token !== token) return;
    setEmergencyW3wText(car_id, 'Emergency W3W: unavailable');
  }
}

async function saveDriverName(car_id, driverName) {
  await fetch(`/api/cars/${encodeURIComponent(car_id)}/driver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_name: String(driverName || '') }),
  });
}

function ensureCar(car_id, name = null, driverName = null) {
  const trackerName = name || `Car ${car_id}`;
  const effectiveDriverName = String(driverName || '').trim();
  const displayName = formatDisplayName(trackerName, effectiveDriverName);
  if (cars[car_id]) {
    if (name) cars[car_id].tracker_name = name;
    if (driverName != null) cars[car_id].driver_name = effectiveDriverName;
    const nextDisplay = formatDisplayName(cars[car_id].tracker_name, cars[car_id].driver_name);
    if (cars[car_id].display_name !== nextDisplay) {
      cars[car_id].display_name = nextDisplay;
      const label = cars[car_id].card.querySelector('.car-number');
      if (label) label.textContent = nextDisplay;
    }
    const driverLabel = document.getElementById(`driver-${car_id}`);
    if (driverLabel) driverLabel.textContent = `Driver: ${cars[car_id].driver_name || '-'}`;
    const driverInput = document.getElementById(`driver-input-${car_id}`);
    if (driverInput && driverName != null && driverInput !== document.activeElement && driverInput.value !== cars[car_id].driver_name) {
      driverInput.value = cars[car_id].driver_name;
    }
    return cars[car_id];
  }

  const marker = L.marker([0, 0], { icon: makeIcon(car_id) })
    .addTo(map)
    .bindPopup(displayName);

  const card = document.createElement('div');
  card.className = 'car-card';
  card.dataset.carId = car_id;
  card.innerHTML = `
    <div class="car-header">
      <span class="car-number">${displayName}</span>
      <span>
        <span class="car-badge" id="badge-${car_id}">acquiring</span>
        <button class="cancel-alert-btn" id="cancel-alert-${car_id}" type="button">Cancel Alert</button>
      </span>
    </div>
    <div class="car-stats">
      <span class="car-wide" id="driver-${car_id}">Driver: ${effectiveDriverName || '-'}</span>
      <span class="car-wide" id="alert-reason-${car_id}">Alert: -</span>
      <span class="car-wide" id="mute-status-${car_id}">Mute: -</span>
      <span id="spd-${car_id}">Speed: —</span>
      <span id="sats-${car_id}">Sats: —</span>
      <span id="acc-${car_id}">RSSI: —</span>
      <span id="bat-${car_id}">Battery: —</span>
      <span id="age-${car_id}">Last: —</span>
      <span class="car-wide" id="w3w-${car_id}">Emergency W3W: -</span>
      <span class="car-wide driver-edit">
        <input class="driver-input" id="driver-input-${car_id}" type="text" maxlength="80" placeholder="Driver name" value="${effectiveDriverName}">
        <button class="driver-save" id="driver-save-${car_id}" type="button">Save Driver</button>
      </span>
    </div>`;
  card.addEventListener('click', () => {
    const c = cars[car_id];
    if (c && c.lat) map.setView([c.lat, c.lon], AUTO_FOCUS_MAX_ZOOM);
  });

  const cancelBtn = card.querySelector(`#cancel-alert-${car_id}`);
  cancelBtn.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    cancelBtn.disabled = true;
    try {
      const resp = await fetch('/api/alert/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ car_id: Number(car_id) })
      });
      const body = await resp.json().catch(() => null);
      if (body?.auto_alert_mutes) {
        setAutoAlertMutes(body.auto_alert_mutes);
        renderMuteStatus(car_id);
      }
    } catch (err) {
      console.warn('[alerts] cancel request failed', err);
    } finally {
      cancelBtn.disabled = false;
    }
  });

  const driverSaveBtn = card.querySelector(`#driver-save-${car_id}`);
  const driverInput = card.querySelector(`#driver-input-${car_id}`);
  driverSaveBtn.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    driverSaveBtn.disabled = true;
    try {
      await saveDriverName(car_id, driverInput.value);
      const resolvedDriver = String(driverInput.value || '').trim();
      cars[car_id].driver_name = resolvedDriver;
      cars[car_id].display_name = formatDisplayName(cars[car_id].tracker_name, resolvedDriver);
      const label = cars[car_id].card.querySelector('.car-number');
      if (label) label.textContent = cars[car_id].display_name;
      setEmergencyW3wText(car_id, document.getElementById(`w3w-${car_id}`)?.textContent || 'Emergency W3W: -');
      const driverLabel = document.getElementById(`driver-${car_id}`);
      if (driverLabel) driverLabel.textContent = `Driver: ${resolvedDriver || '-'}`;
    } catch (err) {
      console.warn('[driver] update failed', err);
    } finally {
      driverSaveBtn.disabled = false;
    }
  });

  document.getElementById('car-list').appendChild(card);

  cars[car_id] = { marker, tracker_name: trackerName, driver_name: effectiveDriverName, display_name: displayName, lat: null, lon: null, speed_cms: 0,
                   accuracy: 0, sat_count: 0, battery_pct: null, last_seen: 0,
                   last_valid_received_at: 0,
                   gps_lock: false,
                   last_packet_ts: 0,
                   expected_interval_ms: DEFAULT_REPORT_INTERVAL_MS,
                   alert_active: false,
                   alert_reason: '',
                   alert_flash_on: false,
                   alert_interval: null,
                   w3w_lookup_token: 0,
                   alert_circle: null,
                   card };
  resetEmergencyW3w(car_id);
  renderMuteStatus(car_id);
  return cars[car_id];
}

const ALERT_FLASH_INTERVAL_MS = 160;
const activeAlertCars = new Set();
const MASTER_ALERT_SOUND_INTERVAL_MS = 20_000;
let commLossIntervalMs = 10 * 60 * 1000;
let masterAlertSoundTimer = null;
let masterAlertAudioCtx = null;

function getMasterAlertAudioContext() {
  if (masterAlertAudioCtx) return masterAlertAudioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;

  masterAlertAudioCtx = new AC();

  const unlock = () => {
    if (!masterAlertAudioCtx) return;
    if (masterAlertAudioCtx.state !== 'running') {
      masterAlertAudioCtx.resume().catch(() => {});
    }
  };

  // Browsers may block audio until a user gesture; keep this lightweight unlock path.
  window.addEventListener('click', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  return masterAlertAudioCtx;
}

function playMasterAlertBeep() {
  const ctx = getMasterAlertAudioContext();
  if (!ctx) return;
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    return;
  }

  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
  gain.connect(ctx.destination);

  const oscA = ctx.createOscillator();
  oscA.type = 'square';
  oscA.frequency.setValueAtTime(880, t0);
  oscA.connect(gain);
  oscA.start(t0);
  oscA.stop(t0 + 0.12);

  const oscB = ctx.createOscillator();
  oscB.type = 'square';
  oscB.frequency.setValueAtTime(660, t0 + 0.12);
  oscB.connect(gain);
  oscB.start(t0 + 0.12);
  oscB.stop(t0 + 0.24);
}

function startMasterAlertSoundLoop() {
  if (!raceActive) return;
  if (masterAlertSoundTimer) return;
  playMasterAlertBeep();
  masterAlertSoundTimer = setInterval(playMasterAlertBeep, MASTER_ALERT_SOUND_INTERVAL_MS);
}

function stopMasterAlertSoundLoop() {
  if (!masterAlertSoundTimer) return;
  clearInterval(masterAlertSoundTimer);
  masterAlertSoundTimer = null;
}

function updateMasterAlertBanner() {
  if (activeAlertCars.size === 0) {
    alertBanner.style.display = 'none';
    alertCar.textContent = '';
    alertReason.textContent = '';
    stopMasterAlertSoundLoop();
    return;
  }

  const carsSorted = Array.from(activeAlertCars).sort((a, b) => a - b);
  const first = carsSorted[0];
  const extra = carsSorted.length - 1;
  alertCar.textContent = extra > 0 ? `${first} (+${extra} more)` : `${first}`;
  const firstReason = cars[first]?.alert_reason || '';
  alertReason.textContent = alertReasonLabel(firstReason);
  alertBanner.style.display = 'block';
  if (raceActive) {
    startMasterAlertSoundLoop();
  } else {
    stopMasterAlertSoundLoop();
  }
}

function stopCarAlertFlash(car_id) {
  const c = cars[car_id];
  if (!c) return;
  if (c.alert_interval) {
    clearInterval(c.alert_interval);
    c.alert_interval = null;
  }
  c.alert_active = false;
  c.alert_reason = '';
  c.alert_flash_on = false;
  c.w3w_lookup_token = (c.w3w_lookup_token || 0) + 1;
  c.marker.setIcon(makeIcon(Number(car_id)));
  if (c.alert_circle) {
    map.removeLayer(c.alert_circle);
    c.alert_circle = null;
  }
  const btn = c.card.querySelector(`#cancel-alert-${car_id}`);
  if (btn) btn.style.display = 'none';
  const reasonEl = document.getElementById(`alert-reason-${car_id}`);
  if (reasonEl) reasonEl.textContent = 'Alert: -';
  if (hasRenderableCoords(c.lat, c.lon)) {
    lookupEmergencyW3w(car_id, c.lat, c.lon);
  } else {
    resetEmergencyW3w(car_id);
  }
  activeAlertCars.delete(Number(car_id));
  renderMuteStatus(car_id);
  updateMasterAlertBanner();
}

function startCarAlertFlash(car_id, lat = null, lon = null, reason = 'driver') {
  const c = ensureCar(car_id);
  stopCarAlertFlash(car_id);

  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  const pulseLat = hasCoords ? Number(lat) : c.lat;
  const pulseLon = hasCoords ? Number(lon) : c.lon;

  c.alert_active = true;
  c.alert_reason = String(reason || 'driver');
  c.alert_flash_on = true;
  activeAlertCars.add(Number(car_id));
  updateMasterAlertBanner();

  if (Number.isFinite(pulseLat) && Number.isFinite(pulseLon)) {
    if (c.alert_circle) map.removeLayer(c.alert_circle);
    c.alert_circle = L.circle([pulseLat, pulseLon], {
      radius: 24,
      color: '#ff1744',
      weight: 2,
      fillColor: '#ff1744',
      fillOpacity: 0.35
    }).addTo(map);
  }

  c.alert_interval = setInterval(() => {
    c.alert_flash_on = !c.alert_flash_on;
    c.marker.setIcon(makeIcon(Number(car_id), 30, c.alert_flash_on ? '#ff1744' : carColor(Number(car_id))));
    if (c.alert_circle) {
      c.alert_circle.setStyle({
        opacity: c.alert_flash_on ? 1 : 0.3,
        fillOpacity: c.alert_flash_on ? 0.42 : 0.12,
      });
    }
  }, ALERT_FLASH_INTERVAL_MS);

  const btn = c.card.querySelector(`#cancel-alert-${car_id}`);
  if (btn) btn.style.display = 'inline-block';
  const reasonEl = document.getElementById(`alert-reason-${car_id}`);
  if (reasonEl) reasonEl.textContent = `Alert: ${alertReasonLabel(c.alert_reason)}`;
  lookupEmergencyW3w(car_id, pulseLat, pulseLon);
}

function setActiveAlerts(alerts) {
  const nextIds = new Set((alerts || []).map((a) => Number(a.car_id)).filter(Number.isFinite));
  for (const [carIdStr, c] of Object.entries(cars)) {
    const carId = Number(carIdStr);
    if (c.alert_active && !nextIds.has(carId)) {
      stopCarAlertFlash(carId);
    }
  }

  for (const alert of (alerts || [])) {
    startCarAlertFlash(alert.car_id, alert.lat, alert.lon, alert.reason || 'driver');
  }
}

function updateCarPosition(car_id, lat, lon, speed_cms, accuracy, sat_count, battery_pct, gps_lock, timestamp, name = null, last_valid_received_at = null) {
  const c = ensureCar(car_id, name, null);
  const now = Date.now();
  const packetTs = Number.isFinite(Number(timestamp)) ? Math.floor(Number(timestamp)) : 0;
  if (packetTs > 0 && c.last_packet_ts > 0) {
    const observed = (packetTs - c.last_packet_ts) * 1000;
    if (observed >= 1000) {
      c.expected_interval_ms = Math.round((0.6 * c.expected_interval_ms) + (0.4 * observed));
    }
  }
  if (packetTs > 0) c.last_packet_ts = packetTs;
  const sats = Number.isFinite(Number(sat_count)) ? Number(sat_count) : 0;
  const hasGpsLock = !!gps_lock;
  c.lat       = lat;
  c.lon       = lon;
  c.speed_cms = hasGpsLock ? (speed_cms || 0) : 0;
  c.accuracy  = accuracy  || 0;
  c.sat_count = sats;
  c.battery_pct = Number.isFinite(Number(battery_pct)) ? Math.max(0, Math.min(100, Math.round(Number(battery_pct)))) : null;
  c.gps_lock  = hasGpsLock;
  c.last_seen = now;
  if (Number.isFinite(Number(last_valid_received_at)) && Number(last_valid_received_at) > 0) {
    c.last_valid_received_at = Number(last_valid_received_at);
  }

  if (hasRenderableCoords(lat, lon)) {
    c.marker.setLatLng([lat, lon]);
    c.marker.setPopupContent(`${c.display_name}<br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br>${(c.speed_cms / 100 * 3.6).toFixed(1)} km/h`);
    fitShortCourseWindow(lat, lon);
  } else {
    c.marker.setPopupContent(`${c.display_name}<br>No valid GPS position yet<br>${(c.speed_cms / 100 * 3.6).toFixed(1)} km/h`);
  }

  lookupEmergencyW3w(car_id, lat, lon);
}

function hydrateCarFromSnapshot(car, serverTime) {
  const c = ensureCar(car.car_id, car.name || null, car.driver_name || '');
  c.gps_lock = !!car.gps_lock;
  c.sat_count = Number.isFinite(Number(car.sat_count)) ? Number(car.sat_count) : 0;
  c.speed_cms = c.gps_lock ? (car.speed_cms || 0) : 0;
  c.accuracy = car.accuracy || 0;
  c.battery_pct = Number.isFinite(Number(car.battery_pct)) ? Math.max(0, Math.min(100, Math.round(Number(car.battery_pct)))) : null;
  c.expected_interval_ms = car.expected_interval_ms || c.expected_interval_ms;
  c.last_packet_ts = car.last_seen || 0;
  c.last_valid_received_at = Number(car.last_valid_received_at || 0);

  if (car.lat != null && car.lon != null && hasRenderableCoords(car.lat, car.lon)) {
    c.lat = car.lat;
    c.lon = car.lon;
    c.marker.setLatLng([car.lat, car.lon]);
    c.marker.setPopupContent(`${c.display_name}<br>${car.lat.toFixed(6)}, ${car.lon.toFixed(6)}<br>${(c.speed_cms / 100 * 3.6).toFixed(1)} km/h`);
  } else {
    c.marker.setPopupContent(`${c.display_name}<br>No valid GPS position yet<br>${(c.speed_cms / 100 * 3.6).toFixed(1)} km/h`);
  }

  const receivedAt = car.last_received_at || car.last_seen || serverTime || Math.floor(Date.now() / 1000);
  const ageMs = Math.max(0, ((serverTime || receivedAt) - receivedAt) * 1000);
  c.last_seen = Date.now() - ageMs;

  if (hasRenderableCoords(c.lat, c.lon)) {
    lookupEmergencyW3w(car.car_id, c.lat, c.lon);
  } else {
    resetEmergencyW3w(car.car_id);
  }
}

// Sidebar refresh (runs every second)
function refreshSidebar() {
  const now = Date.now();
  applyRaceState(raceActive, raceStartedAt, raceElapsedSeconds);
  for (const [car_id, c] of Object.entries(cars)) {
    const age   = c.last_seen ? (now - c.last_seen) : Number.POSITIVE_INFINITY;
    const badge = document.getElementById(`badge-${car_id}`);
    const card  = c.card;

    const reportMs = Math.max(1000, Number(c.expected_interval_ms || DEFAULT_REPORT_INTERVAL_MS));
    const staleMs = reportMs * 2;
    const lostMs = reportMs * 5;

    const lostComms = age >= lostMs;
    const staleComms = !lostComms && age >= staleMs;
    const noGps = !c.gps_lock;
    const hasStartupGps = Number(c.last_valid_received_at || 0) >= serverStartedAtUnix;

    if (!hasStartupGps) {
      badge.textContent = 'idle';
      badge.className = 'car-badge idle';
      card.className = 'car-card idle';
    } else if (lostComms) {
      badge.textContent = 'lost';
      badge.className = 'car-badge lost';
      card.className = 'car-card lost';
    } else if (staleComms) {
      badge.textContent = 'stale';
      badge.className = 'car-badge stale';
      card.className = 'car-card stale';
    } else if (noGps) {
      badge.textContent = 'no-gps';
      badge.className = 'car-badge stale';
      card.className = 'car-card stale';
    } else {
      badge.textContent = 'active';
      badge.className = 'car-badge';
      card.className = 'car-card active';
    }

    if (c.alert_active) card.classList.add('alerting');
    const cancelBtn = card.querySelector(`#cancel-alert-${car_id}`);
    if (cancelBtn) cancelBtn.style.display = c.alert_active ? 'inline-block' : 'none';
    renderMuteStatus(car_id);

    const ageSec = Math.max(0, Math.floor(age / 1000));
    const shownSpeedCms = c.gps_lock ? c.speed_cms : 0;
    document.getElementById(`spd-${car_id}`).textContent  = `Speed: ${(shownSpeedCms / 100 * 3.6).toFixed(1)} km/h`;
    document.getElementById(`sats-${car_id}`).textContent = `Sats: ${c.sat_count}`;
    document.getElementById(`acc-${car_id}`).textContent  = `RSSI: ${c.accuracy} dBm`;
    document.getElementById(`bat-${car_id}`).textContent  = `Battery: ${c.battery_pct == null ? '—' : `${c.battery_pct}%`}`;
    document.getElementById(`age-${car_id}`).textContent  = hasStartupGps
      ? `Last: ${ageSec}s ago (stale>${Math.round(staleMs/1000)}s, lost>${Math.round(lostMs/1000)}s)`
      : 'Last: No GPS yet';
  }
}

setInterval(refreshSidebar, 1000);

// Fallback refresh path for browsers/tabs that miss early WS snapshot events.
async function refreshCarsFromApi() {
  try {
    const resp = await fetch('/api/cars', { cache: 'no-store' });
    if (!resp.ok) return;
    const carsList = await resp.json();
    const serverTime = Math.floor(Date.now() / 1000);
    for (const car of (carsList || [])) {
      hydrateCarFromSnapshot(car, serverTime);
    }
  } catch {
    // Keep quiet; WebSocket remains the primary path.
  }
}

setInterval(refreshCarsFromApi, 5000);

// =============================================================================
//  Alerts
// =============================================================================

const alertBanner = document.getElementById('alert-banner');
const alertCar    = document.getElementById('alert-car');
const alertReason = document.getElementById('alert-reason');
const raceStateEl = document.getElementById('race-state');
const raceStartBtn = document.getElementById('race-start');
const raceStopBtn = document.getElementById('race-stop');

function applyRaceState(active, startedAt = null, elapsedSeconds = null) {
  raceActive = !!active;
  if (Number.isFinite(Number(startedAt)) && Number(startedAt) > 0) {
    raceStartedAt = Number(startedAt);
  } else if (!raceActive) {
    raceStartedAt = null;
  }
  if (Number.isFinite(Number(elapsedSeconds)) && Number(elapsedSeconds) >= 0) {
    raceElapsedSeconds = Math.floor(Number(elapsedSeconds));
  }

  const shownElapsed = raceActive && raceStartedAt
    ? Math.max(0, Math.floor(Date.now() / 1000) - raceStartedAt)
    : raceElapsedSeconds;

  raceStateEl.textContent = `Race: ${raceActive ? 'RUNNING' : 'STOPPED'} ${formatRaceHms(shownElapsed)}`;
  raceStartBtn.classList.toggle('active', raceActive);
  raceStopBtn.classList.toggle('active', !raceActive);
  if (!raceActive) {
    stopMasterAlertSoundLoop();
  } else if (activeAlertCars.size > 0) {
    startMasterAlertSoundLoop();
  }
}

async function setRaceState(active) {
  const resp = await fetch('/api/race-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!active })
  });
  if (!resp.ok) throw new Error(`race_state_http_${resp.status}`);
  const body = await resp.json().catch(() => null);
  applyRaceState(
    !!body?.race?.active,
    Number.isFinite(Number(body?.race?.started_at)) ? Number(body.race.started_at) : null,
    Number.isFinite(Number(body?.race?.elapsed_seconds)) ? Number(body.race.elapsed_seconds) : null
  );
}

raceStartBtn.addEventListener('click', async () => {
  raceStartBtn.disabled = true;
  try {
    await setRaceState(true);
  } catch (err) {
    console.warn('[race] start failed', err);
  } finally {
    raceStartBtn.disabled = false;
  }
});

raceStopBtn.addEventListener('click', async () => {
  raceStopBtn.disabled = true;
  try {
    await setRaceState(false);
  } catch (err) {
    console.warn('[race] stop failed', err);
  } finally {
    raceStopBtn.disabled = false;
  }
});

// =============================================================================
//  WebSocket
// =============================================================================

const statusBar = document.getElementById('status-bar');
const tileDebug = document.getElementById('tile-debug');
let   ws;

function updateGatewayStatus(gateway) {
  const connected = !!gateway?.connected;
  if (connected) {
    statusBar.textContent = 'Live — gateway connected';
    statusBar.className = 'connected';
  } else {
    statusBar.textContent = 'No Gateway';
    statusBar.className = 'warning';
  }
}

async function clearStaleBrowserState() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
      }
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Non-fatal; diagnostics below will still report tile fetch status.
  }
}

async function runTileSelfTest() {
  if (!tileDebug) return;

  let meta = null;
  try {
    const metaResp = await fetch('/tiles/meta', { cache: 'no-store' });
    if (metaResp.ok) meta = await metaResp.json();
  } catch {
    meta = null;
  }

  const probePath = '/tiles/14/16048/10358';
  const probeUrl = `${location.origin}${probePath}?t=${Date.now()}`;
  try {
    const resp = await fetch(probeUrl, { cache: 'no-store' });
    const tileSource = String(resp.headers.get('x-race-tracker-tile-source') || '-');
    const contentLength = Number(resp.headers.get('content-length') || '0');
    const tileOk = resp.ok && !tileSource.startsWith('blank') && contentLength > TILE_NONBLANK_MIN_BYTES;
    const mode = meta && meta.mode ? meta.mode : 'unknown';
    tileDebug.textContent = `Tile check: ${probePath} -> ${resp.status}, src=${tileSource}, bytes=${contentLength}, mode=${mode} (${location.host})`;
    tileDebug.style.color = tileOk ? '#7cb342' : '#f44336';
  } catch (e) {
    tileDebug.textContent = `Tile check: fetch failed (${location.host})`;
    tileDebug.style.color = '#f44336';
    console.warn('[map] tile self-test failed:', e);
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    statusBar.textContent = 'Connected — waiting gateway status';
    statusBar.className = 'warning';
    refreshCarsFromApi();
  };

  ws.onclose = () => {
    statusBar.textContent = 'Disconnected — reconnecting…';
    statusBar.className = 'error';
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'snapshot') {
      const serverTime = Number.isFinite(Number(msg.server_time)) ? Number(msg.server_time) : Math.floor(Date.now() / 1000);
      if (Number.isFinite(Number(msg.comm_loss_interval_ms)) && Number(msg.comm_loss_interval_ms) > 1000) {
        commLossIntervalMs = Number(msg.comm_loss_interval_ms);
      }
      if (Number.isFinite(Number(msg.server_started_at)) && Number(msg.server_started_at) > 0) {
        serverStartedAtUnix = Number(msg.server_started_at);
      }
      setAutoAlertMutes(msg.auto_alert_mutes || []);
      updateGatewayStatus(msg.gateway || null);
      applyRaceState(
        !!msg.race?.active,
        Number.isFinite(Number(msg.race?.started_at)) ? Number(msg.race.started_at) : null,
        Number.isFinite(Number(msg.race?.elapsed_seconds)) ? Number(msg.race.elapsed_seconds) : null
      );
      for (const car of (msg.cars || [])) {
        hydrateCarFromSnapshot(car, serverTime);
      }
      setActiveAlerts(msg.active_alerts || []);
      // Centre map on first car with a position
      const first = (msg.cars || []).find(c => c.lat != null);
      if (first) fitShortCourseWindow(first.lat, first.lon);

    } else if (msg.type === 'position') {
      updateCarPosition(msg.car_id, msg.lat, msg.lon,
                        msg.speed_cms, msg.accuracy, msg.sat_count, msg.battery_pct, msg.gps_lock, msg.timestamp, msg.name || null, msg.last_valid_received_at || null);

    } else if (msg.type === 'register') {
      const c = ensureCar(msg.car_id, msg.name || null);
      c.last_seen = Date.now();
      if (Number.isFinite(Number(msg.timestamp)) && Number(msg.timestamp) > 0) {
        c.last_packet_ts = Math.floor(Number(msg.timestamp));
      }
      if (msg.lat != null && msg.lon != null && c.lat == null && c.lon == null) {
        c.lat = Number(msg.lat);
        c.lon = Number(msg.lon);
        c.marker.setLatLng([c.lat, c.lon]);
      }

    } else if (msg.type === 'alert') {
      startCarAlertFlash(msg.car_id, msg.lat, msg.lon, msg.alert_reason || 'driver');

    } else if (msg.type === 'alert_cleared') {
      stopCarAlertFlash(msg.car_id);

    } else if (msg.type === 'alert_state') {
      setActiveAlerts(msg.alerts || []);

    } else if (msg.type === 'gateway_status') {
      updateGatewayStatus(msg.gateway || null);

    } else if (msg.type === 'race_state') {
      applyRaceState(
        !!msg.race?.active,
        Number.isFinite(Number(msg.race?.started_at)) ? Number(msg.race.started_at) : null,
        Number.isFinite(Number(msg.race?.elapsed_seconds)) ? Number(msg.race.elapsed_seconds) : null
      );

    } else if (msg.type === 'driver_name_updated') {
      const c = cars[msg.car_id] || ensureCar(msg.car_id);
      c.driver_name = String(msg.driver_name || '');
      c.display_name = formatDisplayName(c.tracker_name, c.driver_name);
      const label = c.card.querySelector('.car-number');
      if (label) label.textContent = c.display_name;
      const driverLabel = document.getElementById(`driver-${msg.car_id}`);
      if (driverLabel) driverLabel.textContent = `Driver: ${c.driver_name || '-'}`;
      const driverInput = document.getElementById(`driver-input-${msg.car_id}`);
      if (driverInput && driverInput !== document.activeElement) driverInput.value = c.driver_name;

    } else if (msg.type === 'auto_alert_mutes') {
      setAutoAlertMutes(msg.mutes || []);

    } else if (msg.type === 'lap') {
      console.log(`Lap event: car ${msg.car_id} lap ${msg.lap_number} type ${msg.crossing_type}`);
    }
  };
}

connect();

clearStaleBrowserState().finally(() => {
  runTileSelfTest();
  setInterval(runTileSelfTest, 10000);
});
