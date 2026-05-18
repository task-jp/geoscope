"""Tile serving endpoints.

Serves RRIM (Red Relief Image Map), Terrarium DEM, 3-channel, crop tiles, and STL 3D models from local WebP DEM data.
"""

import asyncio
import struct
from pathlib import Path

import cv2
import numpy as np
from cachetools import LRUCache
from fastapi import APIRouter, Response

import math

from app.config import settings
from app.core.dem import TILE_PX, decode_dem
from app.core.visualization import cs_map, dem_to_3ch

router = APIRouter(prefix="/tiles", tags=["tiles"])

cs_cache: LRUCache = LRUCache(maxsize=settings.tile_cache_size)
terrain_cache: LRUCache = LRUCache(maxsize=settings.tile_cache_size)

# Cache-Control: CDN(CloudFlare)で30日、ブラウザで1日キャッシュ
TILE_HEADERS_PNG = {"Content-Type": "image/png", "Cache-Control": "public, max-age=86400, s-maxage=2592000"}
TILE_HEADERS_WEBP = {"Content-Type": "image/webp", "Cache-Control": "public, max-age=86400, s-maxage=2592000"}


def _tile_path(z: int, x: int, y: int) -> Path:
    return Path(settings.tiles_dir) / str(z) / str(x) / f"{y}.webp"


def _load_elev(path: Path) -> np.ndarray | None:
    """Load and decode DEM tile. Returns None if invalid."""
    if not path.exists():
        return None
    elev = decode_dem(path.read_bytes())
    valid = elev[~np.isnan(elev)]
    if len(valid) < 100:
        return None
    return elev


def _load_elev_padded(z: int, x: int, y: int, margin: int = 50) -> tuple[np.ndarray | None, int]:
    """Load DEM tile with margin from neighboring tiles for seamless edge computation.

    Returns (padded_elev, margin) where padded_elev includes neighbor data.
    The center tile occupies [margin:margin+TILE_PX, margin:margin+TILE_PX].
    """
    center = _load_elev(_tile_path(z, x, y))
    if center is None:
        return None, 0

    m = margin
    h, w = center.shape
    padded = np.full((h + 2 * m, w + 2 * m), np.nan, dtype=np.float64)
    padded[m:m + h, m:m + w] = center

    # 隣接8タイルのマージン部分を読み込み
    neighbors = [
        (-1, -1, slice(0, m), slice(0, m), slice(h - m, h), slice(w - m, w)),
        (-1,  0, slice(0, m), slice(m, m + w), slice(h - m, h), slice(0, w)),
        (-1,  1, slice(0, m), slice(m + w, m + w + m), slice(h - m, h), slice(0, m)),
        ( 0, -1, slice(m, m + h), slice(0, m), slice(0, h), slice(w - m, w)),
        ( 0,  1, slice(m, m + h), slice(m + w, m + w + m), slice(0, h), slice(0, m)),
        ( 1, -1, slice(m + h, m + h + m), slice(0, m), slice(0, m), slice(w - m, w)),
        ( 1,  0, slice(m + h, m + h + m), slice(m, m + w), slice(0, m), slice(0, w)),
        ( 1,  1, slice(m + h, m + h + m), slice(m + w, m + w + m), slice(0, m), slice(0, m)),
    ]
    for dy, dx, py_sl, px_sl, sy_sl, sx_sl in neighbors:
        nb = _load_elev(_tile_path(z, x + dx, y + dy))
        if nb is not None:
            padded[py_sl, px_sl] = nb[sy_sl, sx_sl]

    return padded, m


def _render_cs(z: int, x: int, y: int) -> bytes | None:
    key = (z, x, y)
    cached = cs_cache.get(key)
    if cached is not None:
        return cached
    padded, m = _load_elev_padded(z, x, y, margin=50)
    if padded is None:
        return None
    img_full = cs_map(padded)
    # マージンを切り取って中心タイルだけ返す
    img = img_full[m:m + TILE_PX, m:m + TILE_PX]
    _, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, 80])
    data = buf.tobytes()
    cs_cache[key] = data
    return data


def _encode_terrarium(filled: np.ndarray) -> bytes:
    """Encode elevation array to Terrarium PNG."""
    val = filled + 32768
    r = np.clip(np.floor(val / 256), 0, 255).astype(np.uint8)
    g = np.clip(np.floor(val % 256), 0, 255).astype(np.uint8)
    b = np.clip(np.floor((val * 256) % 256), 0, 255).astype(np.uint8)
    img = cv2.merge([b, g, r])
    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _fill_nan_interpolate(elev: np.ndarray) -> np.ndarray:
    """NaNを周囲の有効値で補間（距離ベース）。少量NaN向け。"""
    filled = elev.copy()
    nan_mask = np.isnan(filled)
    if not nan_mask.any():
        return filled
    # scipy available: use nearest-neighbor interpolation
    from scipy.ndimage import distance_transform_edt
    valid_mask = ~nan_mask
    if not valid_mask.any():
        filled[nan_mask] = 0
        return filled
    _, indices = distance_transform_edt(nan_mask, return_distances=True, return_indices=True)
    filled[nan_mask] = filled[tuple(indices[:, nan_mask])]
    return filled


def _render_terrain(z: int, x: int, y: int) -> bytes | None:
    key = (z, x, y)
    cached = terrain_cache.get(key)
    if cached is not None:
        return cached

    if z > 16:
        # z=17+: z=16タイルから256pxサブタイルを切り出し（メッシュ密度向上）
        shift = z - 16
        parent_x = x >> shift
        parent_y = y >> shift
        parent_elev = _load_elev(_tile_path(16, parent_x, parent_y))
        if parent_elev is None:
            return None
        sub_size = TILE_PX >> shift
        sx = (x & ((1 << shift) - 1)) * sub_size
        sy = (y & ((1 << shift) - 1)) * sub_size
        filled = _fill_nan_interpolate(parent_elev[sy:sy + sub_size, sx:sx + sub_size])
    else:
        elev = _load_elev(_tile_path(z, x, y))
        if elev is None:
            return None
        filled = _fill_nan_interpolate(elev)

    data = _encode_terrarium(filled)
    terrain_cache[key] = data
    return data


def _render_3ch(z: int, x: int, y: int, ox: int = 0, oy: int = 0) -> bytes | None:
    if ox == 0 and oy == 0:
        elev = _load_elev(_tile_path(z, x, y))
        if elev is None:
            return None
    else:
        # オフセットタイル: 隣接DEMを結合
        canvas = np.full((TILE_PX, TILE_PX), np.nan)
        tile_cache = {}
        for dty in range(2):
            for dtx in range(2):
                stx = x + (1 if ox + dtx * (TILE_PX // 2) >= TILE_PX else 0)
                sty = y + (1 if oy + dty * (TILE_PX // 2) >= TILE_PX else 0)
                if (stx, sty) not in tile_cache:
                    e = _load_elev(_tile_path(z, stx, sty))
                    if e is not None:
                        tile_cache[(stx, sty)] = e
        if not tile_cache:
            return None
        for (ttx, tty), e in tile_cache.items():
            gx_start = ttx * TILE_PX - (x * TILE_PX + ox)
            gy_start = tty * TILE_PX - (y * TILE_PX + oy)
            sx1, sy1 = max(0, -gx_start), max(0, -gy_start)
            dx1, dy1 = max(0, gx_start), max(0, gy_start)
            w = min(TILE_PX - sx1, TILE_PX - dx1)
            h = min(TILE_PX - sy1, TILE_PX - dy1)
            if w > 0 and h > 0:
                canvas[dy1:dy1+h, dx1:dx1+w] = e[sy1:sy1+h, sx1:sx1+w]
        valid = canvas[~np.isnan(canvas)]
        if len(valid) < TILE_PX * TILE_PX * 0.3:
            return None
        canvas[np.isnan(canvas)] = np.nanmean(canvas) if len(valid) > 0 else 0
        elev = canvas
    img = dem_to_3ch(elev)
    _, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, 80])
    return buf.tobytes()


@router.get("/list/{z}")
async def list_tiles(z: int) -> Response:
    """Return all available tile coordinates for a zoom level. Compact binary format: 4 bytes per tile (uint16 x + uint16 y)."""
    import struct
    scan_dir = Path(settings.tiles_dir) / str(z)
    if not scan_dir.exists():
        return Response(status_code=404)
    buf = bytearray()
    for x_dir in sorted(scan_dir.iterdir()):
        if not x_dir.is_dir():
            continue
        tx = int(x_dir.name)
        for f in sorted(x_dir.glob("*.webp")):
            ty = int(f.stem)
            buf.extend(struct.pack("<HH", tx, ty))
    return Response(content=bytes(buf), media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=86400, s-maxage=2592000"})


@router.get("/dem/{z}/{x}/{y}.webp")
async def get_dem_tile(z: int, x: int, y: int) -> Response:
    """Serve raw DEM WebP tile (no auth, Cloudflare cacheable)."""
    path = _tile_path(z, x, y)
    if not path.exists():
        return Response(status_code=404)
    return Response(content=path.read_bytes(), headers=TILE_HEADERS_WEBP)


_3ch_semaphore = asyncio.Semaphore(1)  # 同時3ch変換を1に制限（OOM防止、15GBサーバー）

@router.get("/3ch/{z}/{x}/{y}.webp")
async def get_3ch_tile(z: int, x: int, y: int, ox: int = 0, oy: int = 0) -> Response:
    """Serve 3-channel tile. ox/oy: pixel offset for overlapping tiles (0 or 256)."""
    async with _3ch_semaphore:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, _render_3ch, z, x, y, ox, oy)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_WEBP)


EXTENDED_PX = TILE_PX + TILE_PX // 2  # 768


def _render_3ch_extended(z: int, x: int, y: int) -> bytes | None:
    """Render 150% extended 3ch tile (768×768)."""
    half = TILE_PX // 2
    canvas = np.full((EXTENDED_PX, EXTENDED_PX), np.nan)

    main = _load_elev(_tile_path(z, x, y))
    if main is None:
        return None
    main_valid = main[~np.isnan(main)]
    if len(main_valid) < TILE_PX * TILE_PX * 0.3:
        return None
    canvas[:TILE_PX, :TILE_PX] = main

    right = _load_elev(_tile_path(z, x + 1, y))
    if right is not None:
        canvas[:TILE_PX, TILE_PX:] = right[:, :half]

    below = _load_elev(_tile_path(z, x, y + 1))
    if below is not None:
        canvas[TILE_PX:, :TILE_PX] = below[:half, :]

    diag = _load_elev(_tile_path(z, x + 1, y + 1))
    if diag is not None:
        canvas[TILE_PX:, TILE_PX:] = diag[:half, :half]

    valid = canvas[~np.isnan(canvas)]
    if len(valid) < TILE_PX * TILE_PX * 0.3:
        return None
    canvas[np.isnan(canvas)] = np.nanmean(canvas) if len(valid) > 0 else 0
    img = dem_to_3ch(canvas)
    _, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, 80])
    return buf.tobytes()


@router.get("/3ch-ext/{z}/{x}/{y}.webp")
async def get_3ch_extended_tile(z: int, x: int, y: int) -> Response:
    """Serve 150% extended 3-channel tile (768×768) for standalone workers."""
    async with _3ch_semaphore:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, _render_3ch_extended, z, x, y)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_WEBP)


@router.get("/cs/{z}/{x}/{y}.webp")
async def get_cs_tile(z: int, x: int, y: int) -> Response:
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _render_cs, z, x, y)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_WEBP)




@router.get("/terrain/{z}/{x}/{y}.png")
async def get_terrain_tile(z: int, x: int, y: int) -> Response:
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _render_terrain, z, x, y)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_PNG)


@router.get("/crop/{z}/{x}/{y}/{cx}/{cy}/{size}.png")
async def get_crop(z: int, x: int, y: int, cx: int, cy: int, size: int) -> Response:
    """Crop a CS tile image centered at (cx, cy) with given size."""
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _render_cs, z, x, y)
    if data is None:
        return Response(status_code=404)

    def _do_crop() -> bytes | None:
        arr = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
        if img is None:
            return None
        h, w = img.shape[:2]
        half = size // 2
        x1 = max(0, cx - half)
        y1 = max(0, cy - half)
        x2 = min(w, cx + half)
        y2 = min(h, cy + half)
        if x2 <= x1 or y2 <= y1:
            return None
        crop = img[y1:y2, x1:x2]
        _, buf = cv2.imencode(".png", crop)
        return buf.tobytes()

    crop_data = await loop.run_in_executor(None, _do_crop)
    if crop_data is None:
        return Response(status_code=404)
    return Response(content=crop_data, headers=TILE_HEADERS_PNG)


def _latlon_to_pixel(lat: float, lon: float, z: int) -> tuple[int, int, float, float]:
    """lat/lon → (tile_x, tile_y, pixel_x, pixel_y)"""
    n = 2 ** z
    tx = int((lon + 180) / 360 * n)
    lat_rad = math.radians(lat)
    ty = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    px = ((lon + 180) / 360 * n - tx) * TILE_PX
    py = ((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n - ty) * TILE_PX
    return tx, ty, px, py


OG_WIDTH = 1200
OG_HEIGHT = 630


def _render_preview(z: int, lat: float, lon: float) -> bytes | None:
    """指定座標を中心に1200×630のCS画像を複数タイルから合成（OG用）"""
    w, h = OG_WIDTH, OG_HEIGHT
    tx, ty, px, py = _latlon_to_pixel(lat, lon, z)

    # 中心ピクセルのグローバル座標
    gcx = tx * TILE_PX + px
    gcy = ty * TILE_PX + py

    # 切り出し範囲のグローバル座標
    gx1 = int(gcx - w // 2)
    gy1 = int(gcy - h // 2)
    gx2 = gx1 + w
    gy2 = gy1 + h

    # 必要なタイル範囲
    tx_min = gx1 // TILE_PX
    tx_max = (gx2 - 1) // TILE_PX
    ty_min = gy1 // TILE_PX
    ty_max = (gy2 - 1) // TILE_PX

    # キャンバス作成（BGRA）
    canvas = np.zeros((h, w, 4), dtype=np.uint8)

    for ttx in range(tx_min, tx_max + 1):
        for tty in range(ty_min, ty_max + 1):
            cs_data = _render_cs(z, ttx, tty)
            if cs_data is None:
                continue
            arr = np.frombuffer(cs_data, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
            if img is None:
                continue

            # このタイルのグローバル座標範囲
            tile_gx = ttx * TILE_PX
            tile_gy = tty * TILE_PX

            # キャンバス上の貼り付け位置
            dx = tile_gx - gx1
            dy = tile_gy - gy1

            # ソース/デスト範囲をクリップ
            sx1 = max(0, -dx)
            sy1 = max(0, -dy)
            sx2 = min(TILE_PX, w - dx)
            sy2 = min(TILE_PX, h - dy)
            dx1 = max(0, dx)
            dy1 = max(0, dy)
            dx2 = dx1 + (sx2 - sx1)
            dy2 = dy1 + (sy2 - sy1)

            if dx2 <= dx1 or dy2 <= dy1:
                continue

            if img.shape[2] == 4:
                canvas[dy1:dy2, dx1:dx2] = img[sy1:sy2, sx1:sx2]
            else:
                canvas[dy1:dy2, dx1:dx2, :3] = img[sy1:sy2, sx1:sx2]
                canvas[dy1:dy2, dx1:dx2, 3] = 255

    if canvas[:, :, 3].sum() == 0:
        return None

    # Attribution — 中央安全領域(630×630)の右下に配置
    # LINEの1:1クロップでも見えるよう、左右端から285px内側が安全領域
    safe_right = w // 2 + h // 2  # 600 + 315 = 915
    safe_bottom = h - 8
    text = "GeoScope | DEM: GSI Japan"
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 0.45
    thickness = 1
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    x = safe_right - tw - 4
    y = safe_bottom
    cv2.rectangle(canvas, (x - 4, y - th - 4), (safe_right, h), (0, 0, 0, 180), -1)
    cv2.putText(canvas, text, (x, y), font, scale, (255, 255, 255, 255), thickness, cv2.LINE_AA)

    _, buf = cv2.imencode(".png", canvas)
    return buf.tobytes()


def _get_tile_img(z: int, x: int, y: int) -> np.ndarray | None:
    """CSタイルをデコードしてBGRA numpy配列で返す。"""
    cs_data = _render_cs(z, x, y)
    if cs_data is None:
        return None
    arr = np.frombuffer(cs_data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    # 3chの場合は4chに変換
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _render_crop(z: int, x: int, y: int, cx: float, cy: float, w: float, h: float, pad: float = 1.5) -> bytes | None:
    """赤色立体地図タイルからbbox領域をクロップして返す。cx,cy,w,hは正規化値(0-1)。
    bboxがタイル境界をまたぐ場合は隣接タイルを結合する。"""
    # bboxのグローバルピクセル座標
    gcx = x * TILE_PX + cx * TILE_PX
    gcy = y * TILE_PX + cy * TILE_PX
    gpw = w * TILE_PX
    gph = h * TILE_PX

    # パディング付きの表示領域
    margin = max(gpw, gph, 20) * (pad - 1) / 2 + 4
    vl = gcx - gpw / 2 - margin
    vt = gcy - gph / 2 - margin
    vr = gcx + gpw / 2 + margin
    vb = gcy + gph / 2 + margin

    # 正方形化
    vw, vh = vr - vl, vb - vt
    if vw > vh:
        diff = vw - vh
        vt -= diff / 2
        vb += diff / 2
    elif vh > vw:
        diff = vh - vw
        vl -= diff / 2
        vr += diff / 2

    # 必要なタイル範囲
    tx_min = int(vl) // TILE_PX
    tx_max = (int(vr) - 1) // TILE_PX
    ty_min = int(vt) // TILE_PX
    ty_max = (int(vb) - 1) // TILE_PX

    # キャンバス作成
    out_w = int(vr - vl)
    out_h = int(vb - vt)
    if out_w < 1 or out_h < 1:
        return None
    canvas = np.full((out_h, out_w, 4), (220, 220, 220, 255), dtype=np.uint8)

    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            tile_img = _get_tile_img(z, tx, ty)
            if tile_img is None:
                continue
            # タイルのグローバル座標
            tgx = tx * TILE_PX
            tgy = ty * TILE_PX
            # キャンバス上の貼り付け位置
            dx = int(tgx - vl)
            dy = int(tgy - vt)
            sx1 = max(0, -dx)
            sy1 = max(0, -dy)
            sx2 = min(TILE_PX, out_w - dx)
            sy2 = min(TILE_PX, out_h - dy)
            dx1 = max(0, dx)
            dy1 = max(0, dy)
            if sx2 <= sx1 or sy2 <= sy1:
                continue
            src = tile_img[sy1:sy2, sx1:sx2]
            if src.shape[2] == 4 and canvas.shape[2] == 4:
                canvas[dy1:dy1 + sy2 - sy1, dx1:dx1 + sx2 - sx1] = src
            elif src.shape[2] == 3:
                canvas[dy1:dy1 + sy2 - sy1, dx1:dx1 + sx2 - sx1, :3] = src
                canvas[dy1:dy1 + sy2 - sy1, dx1:dx1 + sx2 - sx1, 3] = 255
            else:
                canvas[dy1:dy1 + sy2 - sy1, dx1:dx1 + sx2 - sx1] = src

    # bbox枠を描画（キャンバス座標系、pad > 1.0 の時のみ）
    if pad > 1.0:
        bx1 = int(gcx - gpw / 2 - vl)
        by1 = int(gcy - gph / 2 - vt)
        bx2 = int(gcx + gpw / 2 - vl)
        by2 = int(gcy + gph / 2 - vt)
        bx1 = max(0, min(out_w - 1, bx1))
        by1 = max(0, min(out_h - 1, by1))
        bx2 = max(0, min(out_w - 1, bx2))
        by2 = max(0, min(out_h - 1, by2))
        cv2.rectangle(canvas, (bx1, by1), (bx2, by2), (0, 190, 245, 255), 2)

    _, buf = cv2.imencode(".webp", canvas, [cv2.IMWRITE_WEBP_QUALITY, 85])
    return buf.tobytes()


def _build_stl(south: float, north: float, west: float, east: float,
               max_pixels: int = 512, exaggeration: float = 1.0, base_mm: float = 3.0,
               width_mm: float = 100.0) -> bytes | None:
    """Build binary STL from DEM within bounding box."""
    from app.core.dem import latlon_to_tile_px

    z = 16
    tx1, ty1, px1, py1 = latlon_to_tile_px(north, west, z)
    tx2, ty2, px2, py2 = latlon_to_tile_px(south, east, z)

    gx1 = tx1 * TILE_PX + int(px1)
    gy1 = ty1 * TILE_PX + int(py1)
    gx2 = tx2 * TILE_PX + int(px2)
    gy2 = ty2 * TILE_PX + int(py2)
    full_w, full_h = gx2 - gx1, gy2 - gy1
    if full_w <= 0 or full_h <= 0:
        return None

    step = max(1, max(full_w, full_h) // max_pixels)
    sample_w = full_w // step
    sample_h = full_h // step
    if sample_w < 2 or sample_h < 2:
        return None

    elev = np.full((sample_h, sample_w), np.nan, dtype=np.float64)
    tile_cache = {}
    for sy in range(sample_h):
        for sx in range(sample_w):
            gx = gx1 + sx * step
            gy = gy1 + sy * step
            ttx, tty = gx // TILE_PX, gy // TILE_PX
            lpx, lpy = gx % TILE_PX, gy % TILE_PX
            key = (ttx, tty)
            if key not in tile_cache:
                tile_cache[key] = _load_elev(_tile_path(z, ttx, tty))
            tile_data = tile_cache[key]
            if tile_data is not None:
                elev[sy, sx] = tile_data[lpy, lpx]

    valid = elev[~np.isnan(elev)]
    if len(valid) == 0:
        return None

    min_elev = float(np.nanmin(elev))
    elev = np.where(np.isnan(elev), min_elev, elev)
    # DEM1Aリサンプリングモアレ除去
    elev = cv2.blur(elev, (1, 5))
    h, w = elev.shape
    x_scale = width_mm / w
    y_scale = x_scale
    z_scale = x_scale * exaggeration
    base_z = -base_mm
    elev_norm = (elev - min_elev) * z_scale

    num_tri = 2 * (h-1) * (w-1) + 2 + 4 * (w-1) + 4 * (h-1)
    buf = bytearray(80 + 4 + num_tri * 50)
    header = b"GeoScope STL - geoscope.jp"
    buf[0:len(header)] = header
    struct.pack_into("<I", buf, 80, num_tri)
    off = 84

    def put_tri(v0, v1, v2):
        nonlocal off
        e1x, e1y, e1z = v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]
        e2x, e2y, e2z = v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]
        struct.pack_into("<12fH", buf, off,
            e1y*e2z - e1z*e2y, e1z*e2x - e1x*e2z, e1x*e2y - e1y*e2x,
            *v0, *v1, *v2, 0)
        off += 50

    for r in range(h - 1):
        for c in range(w - 1):
            x0, x1 = c * x_scale, (c+1) * x_scale
            y0, y1 = r * y_scale, (r+1) * y_scale
            z00, z10 = elev_norm[r,c], elev_norm[r,c+1]
            z01, z11 = elev_norm[r+1,c], elev_norm[r+1,c+1]
            put_tri((x0,y0,z00), (x1,y0,z10), (x0,y1,z01))
            put_tri((x1,y0,z10), (x1,y1,z11), (x0,y1,z01))

    x_max, y_max = (w-1)*x_scale, (h-1)*y_scale
    put_tri((0,0,base_z), (0,y_max,base_z), (x_max,0,base_z))
    put_tri((x_max,0,base_z), (0,y_max,base_z), (x_max,y_max,base_z))

    for c in range(w - 1):
        x0, x1 = c*x_scale, (c+1)*x_scale
        put_tri((x0,0,base_z), (x1,0,base_z), (x0,0,elev_norm[0,c]))
        put_tri((x1,0,base_z), (x1,0,elev_norm[0,c+1]), (x0,0,elev_norm[0,c]))
        put_tri((x0,y_max,elev_norm[h-1,c]), (x1,y_max,base_z), (x0,y_max,base_z))
        put_tri((x0,y_max,elev_norm[h-1,c]), (x1,y_max,elev_norm[h-1,c+1]), (x1,y_max,base_z))
    for r in range(h - 1):
        y0, y1 = r*y_scale, (r+1)*y_scale
        put_tri((0,y0,elev_norm[r,0]), (0,y1,base_z), (0,y0,base_z))
        put_tri((0,y0,elev_norm[r,0]), (0,y1,elev_norm[r+1,0]), (0,y1,base_z))
        put_tri((x_max,y0,base_z), (x_max,y1,base_z), (x_max,y0,elev_norm[r,w-1]))
        put_tri((x_max,y1,base_z), (x_max,y1,elev_norm[r+1,w-1]), (x_max,y0,elev_norm[r,w-1]))

    return bytes(buf)


_stl_semaphore = asyncio.Semaphore(1)


@router.get("/stl/{south}/{north}/{west}/{east}.stl")
async def get_stl(
    south: float, north: float, west: float, east: float,
    max_pixels: int = 512, exaggeration: float = 1.0,
    base_mm: float = 3.0, width_mm: float = 100.0,
) -> Response:
    """STL 3D model from DEM for 3D printing.
    Params: bounding box, max_pixels (up to 1024), exaggeration, base_mm, width_mm."""
    max_pixels = min(max_pixels, 1024)
    async with _stl_semaphore:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            None, _build_stl, south, north, west, east,
            max_pixels, exaggeration, base_mm, width_mm)
    if data is None:
        return Response(status_code=404)
    return Response(
        content=data,
        media_type="application/sla",
        headers={
            "Content-Disposition": f'attachment; filename="geoscope_{south:.4f}_{west:.4f}.stl"',
            "Cache-Control": "public, max-age=86400",
        })


_crop_semaphore = asyncio.Semaphore(2)

@router.get("/crop/{z}/{x}/{y}/clip.webp")
async def get_clip(z: int, x: int, y: int, cx: float, cy: float, w: float, h: float) -> Response:
    """bbox内部だけをクリッピング（枠なし、パディングなし）。パラメータは正規化値(0-1)。"""
    async with _crop_semaphore:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, _render_crop, z, x, y, cx, cy, w, h, 1.0)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_WEBP)


@router.get("/crop/{z}/{x}/{y}.webp")
async def get_crop(z: int, x: int, y: int, cx: float, cy: float, w: float, h: float) -> Response:
    """赤色立体地図タイルのbbox領域をクロップして返す。パラメータは正規化値(0-1)。"""
    async with _crop_semaphore:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, _render_crop, z, x, y, cx, cy, w, h)
        if data is None:
            return Response(status_code=404)
        return Response(content=data, media_type="image/webp", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/preview/{z}/{lat}/{lon}.png")
async def get_preview(z: int, lat: float, lon: float) -> Response:
    """指定座標中心の赤色立体地図プレビュー画像（OG用 1200×630）"""
    z = max(1, min(16, z))
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _render_preview, z, lat, lon)
    if data is None:
        return Response(status_code=404)
    return Response(content=data, headers=TILE_HEADERS_PNG)
