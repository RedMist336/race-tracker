// Race Tracking — MBTiles tile server
// Serves raster tiles from a local .mbtiles file via Express.
// Uses better-sqlite3 (file-backed) so the full DB is never loaded into RAM.

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const Database = require('better-sqlite3');

const MBTILES_PATH = path.join(__dirname, '..', 'data', 'map.mbtiles');
const UPSTREAM_TILE_URL_TEMPLATE = (process.env.UPSTREAM_TILE_URL_TEMPLATE || '').trim();
const USE_UPSTREAM_TILES = (process.env.USE_UPSTREAM_TILES || '0').trim() === '1';
const UPSTREAM_MINZOOM = parseInt(process.env.UPSTREAM_MINZOOM || '7', 10);
const UPSTREAM_MAXZOOM = parseInt(process.env.UPSTREAM_MAXZOOM || '19', 10);
const OFFLINE_ONLY_TILES = (process.env.OFFLINE_ONLY_TILES || '1').trim() !== '0';
const STRICT_TILE_POISON_BLOCK = (process.env.STRICT_TILE_POISON_BLOCK || '0').trim() === '1';
const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2W7vQAAAAASUVORK5CYII=';
const BLANK_PNG = Buffer.from(BLANK_PNG_BASE64, 'base64');

let tileDb = null;
let tileStmt = null;
let tileMeta = {
  available: false,
  unavailable_reason: 'tile backend not initialized',
  poisoned: false,
  poison_reason: null,
  mode: 'mbtiles',
  offline_only: OFFLINE_ONLY_TILES,
  upstream_host: null,
  format: 'png',
  minzoom: 0,
  maxzoom: 19,
};

const BLOCKED_TILE_HASHES = new Set([
  // OSM "403 access blocked" tile image hashes.
  'b02c44252dac5a5e820ecef1e9bf9200e9407c042df668a466a1aa81a9ecca7a',
  '641c0181751e4029c9ad949cf03f6aee55859ce283a55492c8e28133d9e31c4b',
]);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function openTileDb() {
  try {
    if (!fs.existsSync(MBTILES_PATH)) {
      console.warn('[tiles] map.mbtiles not found — tile endpoint will return 404');
      tileMeta.available = false;
      tileMeta.unavailable_reason = `map.mbtiles not found at ${MBTILES_PATH}`;
      return;
    }
    // Read-only, file-backed — no RAM load regardless of file size.
    tileDb = new Database(MBTILES_PATH, { readonly: true, fileMustExist: true });

    const rows = tileDb.prepare('SELECT name, value FROM metadata').all();
    for (const row of rows) {
      if (row.name === 'format')  tileMeta.format  = row.value || tileMeta.format;
      if (row.name === 'minzoom') tileMeta.minzoom  = parseInt(row.value, 10) || tileMeta.minzoom;
      if (row.name === 'maxzoom') tileMeta.maxzoom  = parseInt(row.value, 10) || tileMeta.maxzoom;
    }

    // Pre-compile the hot tile-fetch statement once for performance.
    tileStmt = tileDb.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?'
    );

    // Detect a poisoned dataset where blocked-tiles imagery was cached into MBTiles.
    const totalTiles = tileDb.prepare('SELECT COUNT(*) AS c FROM tiles').get().c || 0;
    if (totalTiles > 0) {
      const sample = tileDb.prepare('SELECT tile_data FROM tiles LIMIT 1').get();
      if (sample && sample.tile_data) {
        const sampleHash = sha256(sample.tile_data);
        if (BLOCKED_TILE_HASHES.has(sampleHash)) {
          const sameAsSample = tileDb.prepare('SELECT COUNT(*) AS c FROM tiles WHERE tile_data=?').get(sample.tile_data).c || 0;
          const ratio = sameAsSample / totalTiles;
          if (ratio >= 0.90) {
            tileMeta.poisoned = true;
            tileMeta.poison_reason = `blocked_tile_image_detected hash=${sampleHash} ratio=${ratio.toFixed(3)} total=${totalTiles}`;
            console.warn(`[tiles] Refusing poisoned MBTiles dataset: ${tileMeta.poison_reason}`);
          }
        }
      }
    }

    tileMeta.available = true;
    tileMeta.unavailable_reason = null;
    console.log(`[tiles] map.mbtiles loaded (z${tileMeta.minzoom}-z${tileMeta.maxzoom}, format=${tileMeta.format}, poisoned=${tileMeta.poisoned})`);
  } catch (e) {
    tileMeta.available = false;
    tileMeta.unavailable_reason = e.message || 'failed to open map.mbtiles';
    console.warn('[tiles] Failed to open map.mbtiles:', e.message);
  }
}

// MBTiles stores tiles with TMS Y (origin bottom-left).
// Leaflet uses XYZ (origin top-left), so flip Y.
function xyzToTms(z, y) {
  return (1 << z) - 1 - y;
}

function isLoopbackHost(hostname) {
  const h = (hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function resolveValidatedUpstreamTemplate(template) {
  if (!template) return null;
  const hasTokens = template.includes('{z}') && template.includes('{x}') && template.includes('{y}');
  if (!hasTokens) return null;

  try {
    const probeUrl = template
      .replace('{z}', '0')
      .replace('{x}', '0')
      .replace('{y}', '0');
    const parsed = new URL(probeUrl);
    if (parsed.protocol !== 'http:') {
      console.warn(`[tiles] Ignoring UPSTREAM_TILE_URL_TEMPLATE with non-http protocol: ${parsed.protocol}`);
      return null;
    }
    if (OFFLINE_ONLY_TILES && !isLoopbackHost(parsed.hostname)) {
      console.warn(`[tiles] Ignoring non-local UPSTREAM_TILE_URL_TEMPLATE while OFFLINE_ONLY_TILES=1: host=${parsed.hostname}`);
      return null;
    }
    return { template, hostname: parsed.hostname };
  } catch (e) {
    console.warn(`[tiles] Ignoring invalid UPSTREAM_TILE_URL_TEMPLATE: ${e.message}`);
    return null;
  }
}

function registerTileRoute(app) {
  const upstreamConfig = resolveValidatedUpstreamTemplate(UPSTREAM_TILE_URL_TEMPLATE);
  openTileDb();
  const canServeMbtiles = !!tileDb && !!tileStmt && (!tileMeta.poisoned || !STRICT_TILE_POISON_BLOCK);
  const useUpstream = USE_UPSTREAM_TILES && !!upstreamConfig && !canServeMbtiles;
  const allowMissingTileUpstreamFallback = USE_UPSTREAM_TILES && !!upstreamConfig;

  if (USE_UPSTREAM_TILES && !upstreamConfig) {
    console.warn('[tiles] USE_UPSTREAM_TILES=1 but UPSTREAM_TILE_URL_TEMPLATE is invalid/unusable; falling back to MBTiles');
  }
  if (USE_UPSTREAM_TILES && canServeMbtiles) {
    console.log('[tiles] USE_UPSTREAM_TILES=1 requested, but MBTiles is healthy; serving MBTiles for offline reliability');
    if (allowMissingTileUpstreamFallback) {
      console.log('[tiles] Missing MBTiles tiles will fall back to upstream renderer');
    }
  }

  if (useUpstream) {
    tileMeta.available = true;
    tileMeta.unavailable_reason = null;
    tileMeta.poisoned = false;
    tileMeta.poison_reason = null;
    tileMeta.mode = 'upstream';
    tileMeta.upstream_host = upstreamConfig.hostname;
    tileMeta.format = 'png';
    tileMeta.minzoom = Number.isInteger(UPSTREAM_MINZOOM) ? UPSTREAM_MINZOOM : 7;
    tileMeta.maxzoom = Number.isInteger(UPSTREAM_MAXZOOM) ? UPSTREAM_MAXZOOM : 19;
    console.log(`[tiles] Upstream renderer enabled (offline-only=${OFFLINE_ONLY_TILES}): ${upstreamConfig.template}`);
  } else {
    tileMeta.mode = 'mbtiles';
    tileMeta.upstream_host = null;
    if (allowMissingTileUpstreamFallback) {
      tileMeta.maxzoom = Math.max(
        tileMeta.maxzoom,
        Number.isInteger(UPSTREAM_MAXZOOM) ? UPSTREAM_MAXZOOM : 19
      );
    }
  }

  app.get('/tiles/meta', (_req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(tileMeta);
  });

  app.get('/tiles/:z/:x/:y', async (req, res) => {
    // Always return an image tile (never 4xx) so map clients don't surface access errors
    // for out-of-coverage requests when zooming/panning near dataset boundaries.
    if (tileMeta.mode === 'upstream') {
      const zUp = parseInt(req.params.z, 10);
      const xUp = parseInt(req.params.x, 10);
      const yUp = parseInt(req.params.y, 10);
      if (!Number.isInteger(zUp) || !Number.isInteger(xUp) || !Number.isInteger(yUp) || zUp < 0 || xUp < 0 || yUp < 0) {
        res.set('X-Race-Tracker-Tile-Source', 'blank-invalid');
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).send(BLANK_PNG);
      }
      try {
        const upstreamUrl = UPSTREAM_TILE_URL_TEMPLATE
          .replace('{z}', String(zUp))
          .replace('{x}', String(xUp))
          .replace('{y}', String(yUp));
        const upstreamResp = await fetch(upstreamUrl, { cache: 'no-store' });
        if (!upstreamResp.ok) {
          res.set('X-Race-Tracker-Tile-Source', 'blank-upstream-non200');
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'public, max-age=300');
          return res.status(200).send(BLANK_PNG);
        }
        const contentType = upstreamResp.headers.get('content-type') || 'image/png';
        const body = Buffer.from(await upstreamResp.arrayBuffer());
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=300');
        res.set('X-Race-Tracker-Tile-Source', 'upstream-renderer');
        return res.status(200).send(body);
      } catch {
        res.set('X-Race-Tracker-Tile-Source', 'blank-upstream-error');
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).send(BLANK_PNG);
      }
    }

    if (!tileDb || !tileStmt) {
      res.set('X-Race-Tracker-Tile-Source', 'blank-nodb');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(200).send(BLANK_PNG);
    }

    if (tileMeta.poisoned && STRICT_TILE_POISON_BLOCK) {
      res.set('X-Race-Tracker-Tile-Source', 'blank-poisoned-dataset');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(200).send(BLANK_PNG);
    }

    const z   = parseInt(req.params.z,  10);
    const x   = parseInt(req.params.x,  10);
    const y   = parseInt(req.params.y,  10);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || x < 0 || y < 0) {
      res.set('X-Race-Tracker-Tile-Source', 'blank-invalid');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(200).send(BLANK_PNG);
    }
    const tms = xyzToTms(z, y);

    const row = tileStmt.get(z, x, tms);
    if (!row || !row.tile_data) {
      if (allowMissingTileUpstreamFallback) {
        try {
          const upstreamUrl = UPSTREAM_TILE_URL_TEMPLATE
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
          const upstreamResp = await fetch(upstreamUrl, { cache: 'no-store' });
          if (upstreamResp.ok) {
            const contentType = upstreamResp.headers.get('content-type') || 'image/png';
            const body = Buffer.from(await upstreamResp.arrayBuffer());
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=300');
            res.set('X-Race-Tracker-Tile-Source', 'upstream-fallback');
            return res.status(200).send(body);
          }
          res.set('X-Race-Tracker-Tile-Source', 'blank-upstream-non200');
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'public, max-age=300');
          return res.status(200).send(BLANK_PNG);
        } catch {
          res.set('X-Race-Tracker-Tile-Source', 'blank-upstream-error');
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'public, max-age=300');
          return res.status(200).send(BLANK_PNG);
        }
      }

      res.set('X-Race-Tracker-Tile-Source', 'blank-missing');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(200).send(BLANK_PNG);
    }

    const fmt = tileMeta.format || 'png';
    if (fmt === 'pbf') {
      res.set('Content-Type', 'application/x-protobuf');
      res.set('Content-Encoding', 'gzip');
    } else {
      const mimeFmt = (fmt === 'jpg') ? 'jpeg' : fmt;
      res.set('Content-Type', `image/${mimeFmt}`);
    }

    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Race-Tracker-Tile-Source', tileMeta.poisoned ? 'mbtiles-poisoned-allowed' : 'mbtiles');
    res.send(row.tile_data);
  });
}

module.exports = { registerTileRoute };
