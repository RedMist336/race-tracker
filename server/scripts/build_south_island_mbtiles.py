#!/usr/bin/env python3
import math
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Tile regions
#
# Region 1: South Island NZ overview (low zoom, full island)
#
# Region 2+: Race venues with maximum zoom local coverage.
#   - CORC (West Melton): 10 km radius high-zoom coverage
#   - Ohoka (Waimakariri): 5 km radius high-zoom coverage
#   - Golden Downs (Nelson): 5 km radius high-zoom coverage
#   - OORC (Kurow): 5 km radius high-zoom coverage
# ---------------------------------------------------------------------------


def bbox_from_center_radius_km(center_lat, center_lon, radius_km):
    radius_m = radius_km * 1000.0
    meters_per_deg_lat = 111320.0
    lat_delta = radius_m / meters_per_deg_lat
    cos_lat = max(0.01, math.cos(math.radians(center_lat)))
    lon_delta = radius_m / (meters_per_deg_lat * cos_lat)
    return {
        "min_lon": center_lon - lon_delta,
        "min_lat": center_lat - lat_delta,
        "max_lon": center_lon + lon_delta,
        "max_lat": center_lat + lat_delta,
    }


REGIONS = [
    {
        "name": "South Island overview",
        "min_lon": 166.0, "min_lat": -47.6, "max_lon": 174.9, "max_lat": -40.0,
        "min_z": 7, "max_z": 12,
    },
    {
        "name": "Canterbury Offroad Racing Club (West Melton, 10 km)",
        **bbox_from_center_radius_km(center_lat=-43.545, center_lon=172.075, radius_km=10.0),
        "min_z": 13, "max_z": 19,
    },
    {
        # Golden Downs centre ~-41.543°S 172.885°E; 5 km radius
        "name": "Golden Downs (Nelson)",
        "min_lon": 172.820, "min_lat": -41.593, "max_lon": 172.950, "max_lat": -41.493,
        "min_z": 13, "max_z": 19,
    },
    {
        # OORC at 101 Springhills Rd, Kurow: -44.8129°S 170.4601°E; 5 km radius
        "name": "Otago Offroad Racing Club (Kurow)",
        "min_lon": 170.393, "min_lat": -44.858, "max_lon": 170.527, "max_lat": -44.768,
        "min_z": 13, "max_z": 19,
    },
    {
        # Ohoka centre ~-43.383, 172.526; 5 km radius
        "name": "Ohoka (Waimakariri, 5 km)",
        **bbox_from_center_radius_km(center_lat=-43.383, center_lon=172.526, radius_km=5.0),
        "min_z": 13, "max_z": 19,
    },
]

# Metadata bounds derived from the union of all configured regions
MIN_LON = min(r["min_lon"] for r in REGIONS)
MIN_LAT = min(r["min_lat"] for r in REGIONS)
MAX_LON = max(r["max_lon"] for r in REGIONS)
MAX_LAT = max(r["max_lat"] for r in REGIONS)
MIN_Z   = REGIONS[0]["min_z"]
MAX_Z   = max(r["max_z"] for r in REGIONS)

# Intentionally no default tile URL. Bulk downloading from public OSM tile servers
# violates their tile usage policy for this use-case.
URL_TMPL = os.environ.get("TILE_URL_TEMPLATE", "").strip()
USER_AGENT = os.environ.get("TILE_USER_AGENT", "RaceTrackerTileBuilder/1.0 (offline-cache)")

if not URL_TMPL:
    print("ERROR: TILE_URL_TEMPLATE is required.")
    print("Set it to your own tile source (self-hosted or licensed third-party), e.g.:\n")
    print("  PowerShell:")
    print("    $env:TILE_URL_TEMPLATE = 'https://your-tile-host/{z}/{x}/{y}.png'")
    print("    $env:TILE_USER_AGENT = 'RaceTrackerTileBuilder/1.0 (contact: you@example.com)'")
    print("    python build_south_island_mbtiles.py\n")
    sys.exit(2)

if "tile.openstreetmap.org" in URL_TMPL.lower():
    print("ERROR: Refusing to use tile.openstreetmap.org for bulk MBTiles generation.")
    print("Use a self-hosted renderer or a tile provider that explicitly allows this workload.")
    sys.exit(2)

# Output goes directly into the server's data directory (next to this scripts/ folder)
OUT_DIR = Path(__file__).resolve().parent.parent / "data"
TMP_MB = OUT_DIR / "map.mbtiles.tmp"
OUT_MB = OUT_DIR / "map.mbtiles"
LOG_EVERY = 250


def latlon_to_tile(lat, lon, z):
    lat = max(min(lat, 85.05112878), -85.05112878)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def xyz_to_tms_y(z, y):
    return (2 ** z - 1) - y


def tile_ranges_for_bbox(z, min_lon, min_lat, max_lon, max_lat):
    x1, y_top = latlon_to_tile(max_lat, min_lon, z)
    x2, y_bot = latlon_to_tile(min_lat, max_lon, z)
    n = 2 ** z
    min_x = max(0, min(x1, x2))
    max_x = min(n - 1, max(x1, x2))
    min_y = max(0, min(y_top, y_bot))
    max_y = min(n - 1, max(y_top, y_bot))
    return min_x, max_x, min_y, max_y


def http_get(url, retries=4):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                return r.read()
        except Exception:
            if i == retries - 1:
                return None
            time.sleep(0.7 * (i + 1))
    return None


def init_db(conn):
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("DROP TABLE IF EXISTS metadata;")
    conn.execute("DROP TABLE IF EXISTS tiles;")
    conn.execute("CREATE TABLE metadata (name TEXT, value TEXT);")
    conn.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);")
    conn.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);")
    meta = {
        "name": "Canterbury NZ OSM",
        "type": "baselayer",
        "version": "1",
        "description": "Raster tiles: South Island overview (z7-z12) + race venue detail (z13-z19) for CORC West Melton 10 km, Ohoka 5 km, Golden Downs 5 km, and OORC Kurow 5 km",
        "format": "png",
        "bounds": f"{MIN_LON},{MIN_LAT},{MAX_LON},{MAX_LAT}",
        "minzoom": str(MIN_Z),
        "maxzoom": str(MAX_Z),
    }
    for k, v in meta.items():
        conn.execute("INSERT INTO metadata(name, value) VALUES(?, ?)", (k, v))
    conn.commit()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if TMP_MB.exists():
        TMP_MB.unlink()

    conn = sqlite3.connect(TMP_MB)
    init_db(conn)

    # Pre-calculate total tile count across all regions
    total = 0
    for region in REGIONS:
        for z in range(region["min_z"], region["max_z"] + 1):
            min_x, max_x, min_y, max_y = tile_ranges_for_bbox(
                z, region["min_lon"], region["min_lat"], region["max_lon"], region["max_lat"])
            total += (max_x - min_x + 1) * (max_y - min_y + 1)

    print(f"Planned tiles: {total} across {len(REGIONS)} regions")
    done = 0
    ok = 0
    start = time.time()

    for region in REGIONS:
        print(f"\n--- Region: {region['name']} (z{region['min_z']}-z{region['max_z']}) ---")
        for z in range(region["min_z"], region["max_z"] + 1):
            min_x, max_x, min_y, max_y = tile_ranges_for_bbox(
                z, region["min_lon"], region["min_lat"], region["max_lon"], region["max_lat"])
            count_z = (max_x - min_x + 1) * (max_y - min_y + 1)
            print(f"z={z}: x[{min_x},{max_x}] y[{min_y},{max_y}] ({count_z} tiles)")
            for x in range(min_x, max_x + 1):
                for y in range(min_y, max_y + 1):
                    done += 1
                    data = http_get(URL_TMPL.format(z=z, x=x, y=y))
                    if data:
                        tms_y = xyz_to_tms_y(z, y)
                        conn.execute(
                            "INSERT OR REPLACE INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
                            (z, x, tms_y, data),
                        )
                        ok += 1
                    if done % LOG_EVERY == 0:
                        conn.commit()
                        elapsed = max(1, int(time.time() - start))
                        rate = done / elapsed
                        eta_s = int((total - done) / max(0.1, rate))
                        print(f"progress: {done}/{total} ok={ok} rate={rate:.1f} tiles/s ETA={eta_s}s")

    conn.commit()
    conn.close()

    if OUT_MB.exists():
        OUT_MB.unlink()
    TMP_MB.rename(OUT_MB)

    elapsed = max(1, int(time.time() - start))
    print(f"\nDone: downloaded {ok}/{done} tiles in {elapsed}s")
    print(f"Output: {OUT_MB}")


if __name__ == "__main__":
    main()
