'use strict';

const DEFAULT_LOG_MAP_MAX_ZOOM = 24;
const FALLBACK_LOG_NATIVE_MAX_ZOOM = 22;

const map = L.map('map', { zoomControl: true, minZoom: 7 }).setView([-43.53, 172.64], 9);
let trackLayer = null;
let pointsLayer = null;
let logMapMaxNativeZoom = FALLBACK_LOG_NATIVE_MAX_ZOOM;

const statusEl = document.getElementById('status');
const carFilterEl = document.getElementById('car-filter');
const dateFilterEl = document.getElementById('date-filter');
const logListEl = document.getElementById('log-list');

let allFiles = [];
let activeLogId = null;

function setStatus(msg, color = '#9e9e9e') {
  statusEl.textContent = msg;
  statusEl.style.color = color;
}

async function addBaseTiles() {
  let meta = null;
  try {
    const resp = await fetch('/tiles/meta', { cache: 'no-store' });
    meta = resp.ok ? await resp.json() : null;
  } catch (_) {
    meta = null;
  }

  const cacheBust = `t=${Date.now()}`;
  const tileUrl = `${location.origin}/tiles/{z}/{x}/{y}?${cacheBust}`;

  const minNativeZoom = Number.isFinite(Number(meta && meta.minzoom))
    ? Number(meta.minzoom)
    : 7;
  const maxNativeZoom = Number.isFinite(Number(meta && meta.maxzoom))
    ? Number(meta.maxzoom)
    : FALLBACK_LOG_NATIVE_MAX_ZOOM;
  logMapMaxNativeZoom = Math.max(minNativeZoom, maxNativeZoom);
  const logInteractionMaxZoom = Math.max(DEFAULT_LOG_MAP_MAX_ZOOM, logMapMaxNativeZoom);
  map.setMaxZoom(logInteractionMaxZoom);

  L.tileLayer(tileUrl, {
    attribution: 'Map data © OpenStreetMap contributors',
    minZoom: 7,
    maxZoom: logInteractionMaxZoom,
    minNativeZoom,
    maxNativeZoom: logMapMaxNativeZoom,
    tileSize: 256,
    opacity: 1
  }).addTo(map);
}

function formatTime(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return 'unknown';
  return new Date(Number(ts) * 1000).toISOString();
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

function fillSelect(selectEl, options, allLabel) {
  selectEl.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  selectEl.appendChild(all);

  for (const opt of options) {
    const el = document.createElement('option');
    el.value = String(opt.value);
    el.textContent = opt.label;
    selectEl.appendChild(el);
  }
}

function getFilteredFiles() {
  const carVal = carFilterEl.value;
  const dateVal = dateFilterEl.value;
  return allFiles.filter((f) => {
    if (carVal && String(f.car_id) !== carVal) return false;
    if (dateVal && String(f.log_date) !== dateVal) return false;
    return true;
  });
}

function renderFileList() {
  const files = getFilteredFiles();
  logListEl.innerHTML = '';

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'No logs match the selected filters.';
    logListEl.appendChild(empty);
    return;
  }

  for (const f of files) {
    const item = document.createElement('div');
    item.className = `log-item${activeLogId === f.id ? ' active' : ''}`;
    item.innerHTML = `
      <div><strong>${f.name || `Car ${f.car_id}`}</strong></div>
      <div class="meta">Date: ${f.log_date}</div>
      <div class="meta">File: ${f.file_name}</div>
      <div class="meta">Rows: ${f.row_count} | Uploaded: ${formatTime(f.uploaded_at)}</div>
      <div class="log-actions">
        <button class="delete-log-btn" type="button" data-log-id="${f.id}">Delete</button>
      </div>`;
    item.addEventListener('click', () => loadLog(f.id));

    const delBtn = item.querySelector('.delete-log-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (evt) => {
        evt.stopPropagation();
        const ok = window.confirm(`Delete log file ${f.file_name}? This cannot be undone.`);
        if (!ok) return;
        delBtn.disabled = true;
        try {
          const resp = await fetch(`/api/tracker-logs/${f.id}`, { method: 'DELETE' });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
          await loadFiles();
          if (activeLogId === f.id) {
            activeLogId = null;
            if (trackLayer) { map.removeLayer(trackLayer); trackLayer = null; }
            if (pointsLayer) { map.removeLayer(pointsLayer); pointsLayer = null; }
          }
          const first = getFilteredFiles()[0];
          if (first) {
            loadLog(first.id);
          } else {
            setStatus('Log deleted. No remaining logs for current filters.', '#ffb74d');
          }
        } catch (err) {
          setStatus(`Delete failed: ${err.message}`, '#f44336');
        } finally {
          delBtn.disabled = false;
        }
      });
    }
    logListEl.appendChild(item);
  }
}

async function loadFiles() {
  const [filesResp, carsResp] = await Promise.all([
    fetch('/api/tracker-logs/files', { cache: 'no-store' }),
    fetch('/api/cars', { cache: 'no-store' }).catch(() => null)
  ]);
  if (!filesResp.ok) throw new Error(`HTTP ${filesResp.status}`);
  allFiles = await filesResp.json();

  let cars = [];
  if (carsResp && carsResp.ok) {
    cars = await carsResp.json();
  }

  const nameByCarId = new Map();
  for (const c of cars) {
    if (Number.isFinite(Number(c.car_id)) && c.name) {
      nameByCarId.set(Number(c.car_id), String(c.name));
    }
  }
  for (const f of allFiles) {
    if (Number.isFinite(Number(f.car_id)) && f.name && !nameByCarId.has(Number(f.car_id))) {
      nameByCarId.set(Number(f.car_id), String(f.name));
    }
  }

  const carIds = uniqueSorted([
    ...allFiles.map((f) => Number(f.car_id)),
    ...cars.map((c) => Number(c.car_id))
  ].filter((v) => Number.isFinite(v)));

  const carOptions = carIds.map((car_id) => ({
    value: car_id,
    label: nameByCarId.get(car_id) || `Car ${car_id}`
  }));
  fillSelect(carFilterEl, carOptions, 'All cars');

  const dateOptions = uniqueSorted(allFiles.map((f) => f.log_date)).map((d) => ({
    value: d,
    label: d
  }));
  fillSelect(dateFilterEl, dateOptions, 'All dates');

  renderFileList();
}

function showLogOnMap(log) {
  if (trackLayer) map.removeLayer(trackLayer);
  if (pointsLayer) map.removeLayer(pointsLayer);

  const latlngs = (log.points || []).map((p) => [p.lat, p.lon]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (latlngs.length === 0) {
    setStatus('Selected log has no valid points.', '#ff9800');
    return;
  }

  trackLayer = L.polyline(latlngs, { color: '#00e676', weight: 3, opacity: 0.85 }).addTo(map);

  pointsLayer = L.layerGroup();
  for (const p of log.points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 3,
      color: '#90caf9',
      weight: 1,
      fillOpacity: 0.85
    });
    marker.bindPopup(`
      <div><strong>${log.name || `Car ${log.car_id}`}</strong></div>
      <div>Time: ${formatTime(p.timestamp)}</div>
      <div>Lat/Lon: ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
      <div>Speed: ${(Number(p.speed_cms || 0) / 100 * 3.6).toFixed(1)} km/h</div>
      <div>Sats: ${Number(p.sat_count || 0)}</div>
      <div>Accuracy: ${Number(p.accuracy || 0)}</div>
    `);
    pointsLayer.addLayer(marker);
  }
  pointsLayer.addTo(map);

  map.fitBounds(trackLayer.getBounds(), { padding: [20, 20], maxZoom: logMapMaxNativeZoom });
  setStatus(`Showing ${log.row_count} points for Car ${log.car_id} (${log.log_date})`, '#7cb342');
}

async function loadLog(id) {
  activeLogId = id;
  renderFileList();

  const resp = await fetch(`/api/tracker-logs/${id}`, { cache: 'no-store' });
  if (!resp.ok) {
    setStatus(`Failed to load log ${id} (HTTP ${resp.status})`, '#f44336');
    return;
  }
  const log = await resp.json();
  showLogOnMap(log);
}

carFilterEl.addEventListener('change', renderFileList);
dateFilterEl.addEventListener('change', renderFileList);

addBaseTiles();
loadFiles()
  .then(() => {
    setStatus(`Loaded ${allFiles.length} uploaded log file(s).`);
    const first = getFilteredFiles()[0];
    if (first) loadLog(first.id);
  })
  .catch((err) => {
    setStatus(`Failed to load log files: ${err.message}`, '#f44336');
  });
