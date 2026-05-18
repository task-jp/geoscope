#!/usr/bin/env python3
"""基盤地図情報 DEM1A GML → XYZ WebPタイル変換

入力: FG-GML-*-DEM1A-*.zip (ネストZIP) or ディレクトリ
出力: qchizu_dem1a_tiles/{z}/{x}/{y}.webp (z=10-16, 512x512px)

使い方:
  python3 convert_gml_to_tiles.py /path/to/FG-GML-chubu-DEM1-20251208-Z001.zip
  python3 convert_gml_to_tiles.py /path/to/extracted_dir/
"""

import io
import math
import re
import sys
import time
import zipfile
from pathlib import Path

import cv2
import numpy as np

TILE_PX = 512
OUTPUT_DIR = Path("dem1a_tiles")


def parse_gml(xml_bytes):
    """GML XMLをパースして標高グリッドと範囲を返す"""
    text = xml_bytes.decode("utf-8")

    # 範囲取得
    m = re.search(r'<gml:lowerCorner>([0-9.]+)\s+([0-9.]+)</gml:lowerCorner>', text)
    if not m:
        return None
    lat_min, lon_min = float(m.group(1)), float(m.group(2))

    m = re.search(r'<gml:upperCorner>([0-9.]+)\s+([0-9.]+)</gml:upperCorner>', text)
    if not m:
        return None
    lat_max, lon_max = float(m.group(1)), float(m.group(2))

    # グリッドサイズ
    m = re.search(r'<gml:high>(\d+)\s+(\d+)</gml:high>', text)
    if not m:
        return None
    cols, rows = int(m.group(1)) + 1, int(m.group(2)) + 1

    # startPoint（データの開始位置。先頭にNaNパディングが必要）
    sp = re.search(r'<gml:startPoint>(\d+)\s+(\d+)</gml:startPoint>', text)
    start_x, start_y = (int(sp.group(1)), int(sp.group(2))) if sp else (0, 0)
    start_offset = start_y * cols + start_x

    # 標高データ
    m = re.search(r'<gml:tupleList>\s*(.*?)\s*</gml:tupleList>', text, re.DOTALL)
    if not m:
        return None

    raw_values = []
    for line in m.group(1).strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        parts = line.split(',')
        if len(parts) >= 2:
            try:
                h = float(parts[1])
                raw_values.append(np.nan if h < -9000 else h)
            except ValueError:
                raw_values.append(np.nan)
        else:
            raw_values.append(np.nan)

    # startPointの分だけ先頭にNaNをパディング
    values = [np.nan] * start_offset + raw_values
    total = rows * cols
    if len(values) < total:
        values.extend([np.nan] * (total - len(values)))
    elif len(values) > total:
        values = values[:total]

    grid = np.array(values, dtype=np.float64).reshape(rows, cols)

    return {
        "grid": grid,
        "lat_min": lat_min, "lat_max": lat_max,
        "lon_min": lon_min, "lon_max": lon_max,
        "rows": rows, "cols": cols,
    }


def latlon_to_tile(lat, lon, z):
    """緯度経度→タイルXY"""
    n = 2 ** z
    tx = int((lon + 180) / 360 * n)
    lat_rad = math.radians(lat)
    ty = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    return tx, ty


def decode_dem_webp(data):
    """数値WebP → float64標高配列 (encode_dem_webpの逆)"""
    from PIL import Image as PILImage
    img = PILImage.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img, dtype=np.float64)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    x = r * 65536 + g * 256 + b
    return np.where(x == 2**23, np.nan, np.where(x > 2**23, (x - 2**24) * 0.01, x * 0.01))


def encode_dem_webp(elev):
    """標高→数値WebPエンコーディング (Q地図互換)
    h = (R * 65536 + G * 256 + B) * 0.01
    無効値: R=128, G=0, B=0
    """
    from PIL import Image as PILImage
    h, w = elev.shape
    img = np.zeros((h, w, 3), dtype=np.uint8)

    valid = ~np.isnan(elev)
    vals = np.round(elev[valid] * 100).astype(np.int64)
    vals = np.where(vals < 0, vals + 2 ** 24, vals)

    img[valid, 0] = ((vals >> 16) & 0xFF).astype(np.uint8)  # R
    img[valid, 1] = ((vals >> 8) & 0xFF).astype(np.uint8)   # G
    img[valid, 2] = (vals & 0xFF).astype(np.uint8)           # B

    img[~valid, 0] = 128
    img[~valid, 1] = 0
    img[~valid, 2] = 0

    pil_img = PILImage.fromarray(img, 'RGB')
    buf = io.BytesIO()
    pil_img.save(buf, format='WEBP', lossless=True)
    return buf.getvalue()


def rasterize_to_tile(dem_data, z, tx, ty):
    """DEMデータをタイル座標に投影してTILE_PX×TILE_PXの標高配列を返す（ベクトル化版）"""
    n = 2 ** z

    lon_min = tx / n * 360 - 180
    lon_max = (tx + 1) / n * 360 - 180
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n))))

    if (dem_data["lon_max"] <= lon_min or dem_data["lon_min"] >= lon_max or
            dem_data["lat_max"] <= lat_min or dem_data["lat_min"] >= lat_max):
        return None

    grid = dem_data["grid"]
    g_rows, g_cols = grid.shape
    g_lat_min, g_lat_max = dem_data["lat_min"], dem_data["lat_max"]
    g_lon_min, g_lon_max = dem_data["lon_min"], dem_data["lon_max"]

    # タイルピクセル座標→緯度経度（Web Mercator逆投影）
    py_arr = np.arange(TILE_PX)
    px_arr = np.arange(TILE_PX)
    # 経度は線形
    lons = lon_min + (lon_max - lon_min) * px_arr / TILE_PX
    # 緯度はMercator逆投影（各ピクセル行ごと）
    merc_y = (ty + py_arr / TILE_PX) / n
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * merc_y))))

    # DEMグリッド座標に変換
    gys = (g_lat_max - lats) / (g_lat_max - g_lat_min) * (g_rows - 1)
    gxs = (lons - g_lon_min) / (g_lon_max - g_lon_min) * (g_cols - 1)

    # 範囲内マスク
    gy_valid = (gys >= 0) & (gys < g_rows - 1)
    gx_valid = (gxs >= 0) & (gxs < g_cols - 1)

    if not np.any(gy_valid) or not np.any(gx_valid):
        return None

    # メッシュグリッド
    gy_mesh, gx_mesh = np.meshgrid(gys, gxs, indexing='ij')
    valid_mask = np.outer(gy_valid, gx_valid)

    tile_elev = np.full((TILE_PX, TILE_PX), np.nan, dtype=np.float64)

    # キュービックスプライン補間（離散格子→連続曲面→タイルピクセルでサンプリング）
    from scipy.ndimage import map_coordinates
    nan_mask_grid = np.isnan(grid)
    grid_filled = grid.copy()
    if nan_mask_grid.any():
        grid_filled[nan_mask_grid] = np.nanmean(grid) if not nan_mask_grid.all() else 0

    coords = np.array([gy_mesh, gx_mesh])
    interp = map_coordinates(grid_filled, coords, order=3, mode='nearest', prefilter=True)

    # NaN領域の復元
    if nan_mask_grid.any():
        nan_interp = map_coordinates(nan_mask_grid.astype(np.float64), coords, order=0, mode='constant', cval=1.0)
        interp[nan_interp > 0.5] = np.nan

    tile_elev[valid_mask] = interp[valid_mask]

    if np.isnan(tile_elev).all():
        return None
    return tile_elev


def process_gml(xml_bytes, filename=""):
    """1つのGMLファイルを処理してタイルを生成"""
    dem = parse_gml(xml_bytes)
    if dem is None:
        return 0

    tiles_written = 0

    for z in range(10, 17):
        # このDEMがカバーするタイル範囲
        tx_min, ty_max = latlon_to_tile(dem["lat_min"], dem["lon_min"], z)
        tx_max, ty_min = latlon_to_tile(dem["lat_max"], dem["lon_max"], z)

        for tx in range(tx_min, tx_max + 1):
            for ty in range(ty_min, ty_max + 1):
                tile_elev = rasterize_to_tile(dem, z, tx, ty)
                if tile_elev is None:
                    continue

                # 有効ピクセルが1つもなければスキップ
                if np.isnan(tile_elev).all():
                    continue

                out_path = OUTPUT_DIR / f"{z}/{tx}/{ty}.webp"
                lock_path = OUTPUT_DIR / f"{z}/{tx}/{ty}.lock"

                out_path.parent.mkdir(parents=True, exist_ok=True)

                # ファイルロックで並列マージの競合を防止
                import fcntl
                with open(lock_path, 'w') as lf:
                    fcntl.flock(lf, fcntl.LOCK_EX)
                    try:
                        if out_path.exists():
                            try:
                                existing = decode_dem_webp(out_path.read_bytes())
                            except Exception:
                                existing = None
                            if existing is not None:
                                nan_mask = np.isnan(existing)
                                if not nan_mask.any():
                                    continue
                                existing[nan_mask] = tile_elev[nan_mask]
                                tile_elev = existing

                        webp_data = encode_dem_webp(tile_elev)
                        out_path.write_bytes(webp_data)
                        tiles_written += 1
                    finally:
                        fcntl.flock(lf, fcntl.LOCK_UN)
                try:
                    lock_path.unlink()
                except OSError:
                    pass

    return tiles_written


def process_zip(zip_path):
    """ZIPファイル（ネスト対応）を処理"""
    zip_path = Path(zip_path)
    print(f"Processing: {zip_path.name}", flush=True)

    total_tiles = 0
    total_xmls = 0
    t0 = time.monotonic()

    with zipfile.ZipFile(zip_path) as outer:
        for entry in outer.namelist():
            if entry.endswith('.zip'):
                # ネストZIP
                print(f"  {entry}", flush=True)
                try:
                    with outer.open(entry) as inner_file:
                        inner_data = inner_file.read()
                        with zipfile.ZipFile(io.BytesIO(inner_data)) as inner:
                            for xml_entry in inner.namelist():
                                if xml_entry.endswith('.xml'):
                                    try:
                                        xml_data = inner.read(xml_entry)
                                        n = process_gml(xml_data, xml_entry)
                                        total_tiles += n
                                    except Exception as e:
                                        print(f"    SKIP {xml_entry}: {e}", flush=True)
                                    total_xmls += 1
                                    if total_xmls % 10 == 0:
                                        elapsed = time.monotonic() - t0
                                        print(f"    {total_xmls} XMLs, {total_tiles} tiles "
                                              f"({elapsed:.0f}s)", flush=True)
                except Exception as e:
                    print(f"  SKIP {entry}: {e}", flush=True)

            elif entry.endswith('.xml'):
                try:
                    xml_data = outer.read(entry)
                    n = process_gml(xml_data, entry)
                    total_tiles += n
                except Exception as e:
                    print(f"  SKIP {entry}: {e}", flush=True)
                total_xmls += 1

    elapsed = time.monotonic() - t0
    print(f"Done: {total_xmls} XMLs → {total_tiles} new tiles ({elapsed:.0f}s)")
    return total_tiles


def process_directory(dir_path, workers=None):
    """ディレクトリ内のZIPを並列処理"""
    from multiprocessing import Pool, cpu_count
    import fcntl

    dir_path = Path(dir_path)
    zips = sorted(dir_path.glob("FG-GML-*.zip"))
    print(f"Found {len(zips)} ZIP files")

    if workers is None:
        workers = min(len(zips), cpu_count())
    print(f"Using {workers} workers", flush=True)

    t0 = time.monotonic()
    with Pool(workers) as pool:
        results = pool.map(process_zip, zips)
    total = sum(results)
    elapsed = time.monotonic() - t0
    print(f"\nTotal: {total} new tiles ({elapsed:.0f}s, {workers} workers)")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <zip_or_directory>")
        sys.exit(1)

    path = Path(sys.argv[1])
    if path.is_dir():
        process_directory(path)
    elif path.suffix == '.zip':
        process_zip(path)
    else:
        print(f"Unknown input: {path}")
        sys.exit(1)


if __name__ == "__main__":
    main()
